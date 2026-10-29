import invariant from "tiny-invariant";
import type { Promise } from "workerpool";
import type { ExecOptions } from "workerpool/types/types";

import type { ConcurrencyManager } from "./manager";
import {
  RecyclingWorkerPool,
  type RecyclingWorkerPoolOptions,
} from "./recyclingPool";
import { type CommonTasks } from "./worker";

export type { Promise } from "workerpool";
export type {
  RecyclingWorkerPoolOptions,
  WorkerPoolHeapStats,
  WorkerPoolStats,
} from "./recyclingPool";

const {
  initializeWorkerPool,
  terminateWorkerPool,
  warmUpWorkerPool,
  canWorkerPoolAcceptTasks,
  workerPoolLoad,
  reserveWorkerCore,
  workerPoolReservedSlots,
  worker,
  workerPoolStats,
  workerPoolHeapStats,
  probeWorkerPoolHeap,
} = (() => {
  // Restrict access to this object.
  let worker:
    | {
        pool: RecyclingWorkerPool;
        manager: ConcurrencyManager;
      }
    | undefined;
  /** Cores held by threads outside the pool; outlives the pool itself, so a
   * reservation taken before initialization (or across a re-init) holds. */
  let coreReservations = 0;

  return {
    initializeWorkerPool: (
      url: string,
      manager: ConcurrencyManager,
      options?: RecyclingWorkerPoolOptions,
    ) => {
      if (worker) {
        throw new Error("Worker pool has already been initialized.");
      }

      worker = {
        // Recycles worker threads to bound WASM linear memory growth; see
        // recyclingPool.ts for the policy.
        pool: new RecyclingWorkerPool(url, manager.total, options),
        manager,
      };
      worker.pool.setReservedSlots(coreReservations);
    },
    terminateWorkerPool: () => {
      if (worker) {
        worker.pool.terminate();
        worker = undefined;
      }
    },
    /**
     * Pre-initializes WASM on the workers so that upcoming tasks don't pay
     * the initialization latency. Warms a single worker and resolves once
     * it is ready; the rest warm in the background.
     */
    warmUpWorkerPool: () => {
      invariant(worker, "initializeWorkerPool() must be invoked first.");
      return worker.pool.warmUp();
    },
    /**
     * Whether at least one worker is under its WASM heap budget. While false
     * the engine's worker-task intake must pause so the draining workers
     * reach a task boundary and recycle.
     */
    canWorkerPoolAcceptTasks: () => worker?.pool.canAcceptTasks() ?? true,
    /**
     * Tasks the pool's workers have running or queued, including tasks
     * cancelled while running; see RecyclingWorkerPool.load.
     */
    workerPoolLoad: () => worker?.pool.load() ?? 0,
    /**
     * Hold one core for a thread outside the pool (a font worker, a splat
     * decoder) while it works: one pool slot stops taking tasks and its
     * worker idles once its queued tasks finish. Returns the release
     * function; calling it again is a no-op. At least one slot always keeps
     * taking tasks.
     */
    reserveWorkerCore: (): (() => void) => {
      coreReservations++;
      worker?.pool.setReservedSlots(coreReservations);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        coreReservations--;
        worker?.pool.setReservedSlots(coreReservations);
      };
    },
    /** Pool slots kept free for threads outside the pool right now. */
    workerPoolReservedSlots: () => worker?.pool.reservedSlots() ?? 0,
    worker: () => {
      invariant(worker, "initializeWorkerPool() must be invoked first.");
      return {
        pool: worker.pool,
        manager: worker.manager,
      };
    },
    workerPoolStats: () => worker?.pool.stats(),
    /** Last-probed WASM heap per worker; see RecyclingWorkerPool.heapStats. */
    workerPoolHeapStats: () => worker?.pool.heapStats(),
    /** Requests fresh heap probes (coalesced per worker; display-rate safe). */
    probeWorkerPoolHeap: () => worker?.pool.probeHeap(),
  };
})();

export {
  initializeWorkerPool,
  terminateWorkerPool,
  warmUpWorkerPool,
  canWorkerPoolAcceptTasks,
  workerPoolLoad,
  reserveWorkerCore,
  workerPoolReservedSlots,
  workerPoolStats,
  workerPoolHeapStats,
  probeWorkerPoolHeap,
};

export type { ExecOptions } from "workerpool/types/types";

type GetTaskName<Task> =
  Task extends Record<string, unknown> ? keyof Task : string;

type AnyFunction = (...args: any) => any;

export type WorkerTask<T extends Record<string, AnyFunction>> = T & CommonTasks;

export type TaskParams<
  Task extends CommonTasks,
  Name extends keyof Task,
> = Parameters<
  Task[Name] extends AnyFunction ? Task[Name] : (...args: unknown[]) => unknown
>;
type MethodReturnType<
  Task extends CommonTasks,
  Name extends GetTaskName<Task>,
  R = Awaited<ReturnType<Task[Name]>>,
> = R extends infer U ? U : R;

export function queueTask<
  Task extends CommonTasks,
  Name extends GetTaskName<Task>,
>(
  method: Name,
  params?: TaskParams<Task, Name>,
  options?: ExecOptions,
): Promise<MethodReturnType<Task, Name>> {
  const { pool, manager } = worker();

  manager.increment();

  try {
    return (
      pool
        .exec(method, params, options)
        // `finally` doesn't work, so use `then()` and `catch()` to ensure that `manager.decrement()` is invoked.
        .then((p) => {
          manager.decrement();
          // workerpool types the result as the task's raw return type, but it
          // resolves with the awaited value.
          return p as MethodReturnType<Task, Name>;
        })
        .catch((e) => {
          manager.decrement();
          throw e;
        })
    );
  } catch (e) {
    manager.decrement();
    throw e;
  }
}
