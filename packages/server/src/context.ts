import type { FastifyBaseLogger as Logger } from 'fastify';
import type { Config } from './config/index.js';
import type { Db } from './db/index.js';
import { EventBus } from './events/bus.js';
import { HookHandler } from './hooks/handler.js';
import { EventRepo } from './hooks/repo.js';
import { MessageRepo } from './queue/repo.js';
import { MessageQueue } from './queue/service.js';
import { SessionManager } from './sessions/manager.js';
import { SessionRepo } from './sessions/repo.js';
import { SubOrchestratorService } from './sessions/sub-orchestrators.js';
import { TitleReconciler } from './sessions/reconciler.js';
import { Watchdog } from './sessions/watchdog.js';
import { TaskRepo } from './tasks/repo.js';
import { TaskService } from './tasks/service.js';

export interface AppContext {
  config: Config;
  log: Logger;
  bus: EventBus;
  sessions: SessionManager;
  tasks: TaskService;
  subOrchestrators: SubOrchestratorService;
  queue: MessageQueue;
  hooks: HookHandler;
  events: EventRepo;
  watchdog: Watchdog;
  reconciler: TitleReconciler;
}

/** Composition root: builds the services and wires them together. */
export function createContext(config: Config, db: Db, log: Logger): AppContext {
  const bus = new EventBus();
  const sessionRepo = new SessionRepo(db);
  const sessions = new SessionManager({ config, repo: sessionRepo, bus, log });

  const queue = new MessageQueue(
    new MessageRepo(db),
    {
      getStatus: (id) => sessions.get(id)?.status,
      markBusy: (id) => void sessions.setStatus(id, 'busy'),
      isInputReady: (id) => sessions.liveSession(id)?.isReadyForPaste() ?? false,
      write: (id, data) => sessions.write(id, data),
    },
    bus,
    { onError: (err) => log.error({ err }, 'message delivery failed') },
  );

  const tasks = new TaskService(
    config,
    new TaskRepo(db),
    {
      get: (id) => sessions.get(id),
      countActiveWorkers: () => sessionRepo.countActiveWorkers(),
      startWorker: ({ taskId, cwd, model }) => sessions.create({ cwd, model, taskId, kind: 'worker' }),
      kill: (id) => void sessions.kill(id),
    },
    queue,
    bus,
    log,
  );

  const subOrchestrators = new SubOrchestratorService(config, sessions, queue, log);

  // Delivery trigger: whenever a session becomes idle, flush its inbox (and close finished workers).
  sessions.onStatusChange((session) => {
    if (session.status !== 'idle') return;
    void queue.flush(session.id);
    tasks.handleSessionIdle(session);
  });
  sessions.onEnded((session, info) => {
    tasks.handleSessionEnded(session, info);
    subOrchestrators.handleSessionEnded(session, info);
  });

  const events = new EventRepo(db);
  return {
    config,
    log,
    bus,
    sessions,
    tasks,
    subOrchestrators,
    queue,
    hooks: new HookHandler(sessions, events, bus),
    events,
    watchdog: new Watchdog(sessions),
    reconciler: new TitleReconciler(sessions, events, bus, log),
  };
}
