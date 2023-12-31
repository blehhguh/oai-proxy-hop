/**
 * Very scuffed request queue. OpenAI's GPT-4 keys have a very strict rate limit
 * of 40000 generated tokens per minute. We don't actually know how many tokens
 * a given key has generated, so our queue will simply retry requests that fail
 * with a non-billing related 429 over and over again until they succeed.
 *
 * When a request to a proxied endpoint is received, we create a closure around
 * the call to http-proxy-middleware and attach it to the request. This allows
 * us to pause the request until we have a key available. Further, if the
 * proxied request encounters a retryable error, we can simply put the request
 * back in the queue and it will be retried later using the same closure.
 */

import type { Handler, Request } from "express";
import { keyPool, SupportedModel } from "../shared/key-management";
import {
  getClaudeModelFamily,
  getGooglePalmModelFamily,
  getOpenAIModelFamily,
  ModelFamily,
} from "../shared/models";
import { buildFakeSse, initializeSseStream } from "../shared/streaming";
import { assertNever } from "../shared/utils";
import { logger } from "../logger";
import { SHARED_IP_ADDRESSES } from "./rate-limit";
import { RequestPreprocessor } from "./middleware/request";

const queue: Request[] = [];
const log = logger.child({ module: "request-queue" });

/** Maximum number of queue slots for Agnai.chat requests. */
const AGNAI_CONCURRENCY_LIMIT = 5;
/** Maximum number of queue slots for individual users. */
const USER_CONCURRENCY_LIMIT = 1;

/**
 * Returns an identifier for a request. This is used to determine if a
 * request is already in the queue.
 *
 * This can be (in order of preference):
 * - user token assigned by the proxy operator
 * - x-risu-tk header, if the request is from RisuAI.xyz
 * - 'shared-ip' if the request is from a shared IP address like Agnai.chat
 * - IP address
 */
function getIdentifier(req: Request) {
  if (req.user) return req.user.token;
  if (req.risuToken) return req.risuToken;
  if (isFromSharedIp(req)) return "shared-ip";
  return req.ip;
}

const sharesIdentifierWith = (incoming: Request) => (queued: Request) =>
  getIdentifier(queued) === getIdentifier(incoming);

const isFromSharedIp = (req: Request) => SHARED_IP_ADDRESSES.has(req.ip);

export function enqueue(req: Request) {
  const enqueuedRequestCount = queue.filter(sharesIdentifierWith(req)).length;
  let isGuest = req.user?.token === undefined;

  // Requests from shared IP addresses such as Agnai.chat are exempt from IP-
  // based rate limiting but can only occupy a certain number of slots in the
  // queue. Authenticated users always get a single spot in the queue.
  const isSharedIp = isFromSharedIp(req);
  const maxConcurrentQueuedRequests =
    isGuest && isSharedIp ? AGNAI_CONCURRENCY_LIMIT : USER_CONCURRENCY_LIMIT;
  if (enqueuedRequestCount >= maxConcurrentQueuedRequests) {
    if (isSharedIp) {
      // Re-enqueued requests are not counted towards the limit since they
      // already made it through the queue once.
      if (req.retryCount === 0) {
        throw new Error("Too many agnai.chat requests are already queued");
      }
    } else {
      throw new Error("Your IP or token already has a request in the queue");
    }
  }

  queue.push(req);
  req.queueOutTime = 0;

  // shitty hack to remove hpm's event listeners on retried requests
  removeProxyMiddlewareEventListeners(req);

  // If the request opted into streaming, we need to register a heartbeat
  // handler to keep the connection alive while it waits in the queue. We
  // deregister the handler when the request is dequeued.
  const { stream } = req.body;
  if (stream === "true" || stream === true || req.isStreaming) {
    const res = req.res!;
    if (!res.headersSent) {
      initStreaming(req);
    }
    req.heartbeatInterval = setInterval(() => {
      if (process.env.NODE_ENV === "production") {
        if (!req.query.badSseParser) req.res!.write(": queue heartbeat\n\n");
      } else {
        req.log.info(`Sending heartbeat to request in queue.`);
        const partition = getPartitionForRequest(req);
        const avgWait = Math.round(getEstimatedWaitTime(partition) / 1000);
        const currentDuration = Math.round((Date.now() - req.startTime) / 1000);
        const debugMsg = `queue length: ${queue.length}; elapsed time: ${currentDuration}s; avg wait: ${avgWait}s`;
        req.res!.write(buildFakeSse("heartbeat", debugMsg, req));
      }
    }, 10000);
  }

  // Register a handler to remove the request from the queue if the connection
  // is aborted or closed before it is dequeued.
  const removeFromQueue = () => {
    req.log.info(`Removing aborted request from queue.`);
    const index = queue.indexOf(req);
    if (index !== -1) {
      queue.splice(index, 1);
    }
    if (req.heartbeatInterval) {
      clearInterval(req.heartbeatInterval);
    }
  };
  req.onAborted = removeFromQueue;
  req.res!.once("close", removeFromQueue);

  if (req.retryCount ?? 0 > 0) {
    req.log.info({ retries: req.retryCount }, `Enqueued request for retry.`);
  } else {
    req.log.info(`Enqueued new request.`);
  }
}

function getPartitionForRequest(req: Request): ModelFamily {
  // There is a single request queue, but it is partitioned by model family.
  // Model families are typically separated on cost/rate limit boundaries so
  // they should be treated as separate queues.
  const model = (req.body.model as SupportedModel) ?? "gpt-3.5-turbo";

  // Weird special case for AWS because they serve multiple models from
  // different vendors, even if currently only one is supported.
  if (req.service === "aws") {
    return "aws-claude";
  }

  switch (req.outboundApi) {
    case "anthropic":
      return getClaudeModelFamily(model);
    case "openai":
    case "openai-text":
      return getOpenAIModelFamily(model);
    case "google-palm":
      return getGooglePalmModelFamily(model);
    default:
      assertNever(req.outboundApi);
  }
}

function getQueueForPartition(partition: ModelFamily): Request[] {
  return queue
    .filter((req) => getPartitionForRequest(req) === partition)
    .sort((a, b) => {
      // Certain requests are exempted from IP-based rate limiting because they
      // come from a shared IP address. To prevent these requests from starving
      // out other requests during periods of high traffic, we sort them to the
      // end of the queue.
      const aIsExempted = isFromSharedIp(a);
      const bIsExempted = isFromSharedIp(b);
      if (aIsExempted && !bIsExempted) return 1;
      if (!aIsExempted && bIsExempted) return -1;
      return 0;
    });
}

export function dequeue(partition: ModelFamily): Request | undefined {
  const modelQueue = getQueueForPartition(partition);

  if (modelQueue.length === 0) {
    return undefined;
  }

  const req = modelQueue.reduce((prev, curr) =>
    prev.startTime < curr.startTime ? prev : curr
  );
  queue.splice(queue.indexOf(req), 1);

  if (req.onAborted) {
    req.res!.off("close", req.onAborted);
    req.onAborted = undefined;
  }

  if (req.heartbeatInterval) {
    clearInterval(req.heartbeatInterval);
  }

  // Track the time leaving the queue now, but don't add it to the wait times
  // yet because we don't know if the request will succeed or fail. We track
  // the time now and not after the request succeeds because we don't want to
  // include the model processing time.
  req.queueOutTime = Date.now();
  return req;
}

/**
 * Naive way to keep the queue moving by continuously dequeuing requests. Not
 * ideal because it limits throughput but we probably won't have enough traffic
 * or keys for this to be a problem.  If it does we can dequeue multiple
 * per tick.
 **/
function processQueue() {
  // This isn't completely correct, because a key can service multiple models.
  // Currently if a key is locked out on one model it will also stop servicing
  // the others, because we only track one rate limit per key.

  // TODO: `getLockoutPeriod` uses model names instead of model families
  // TODO: genericize this it's really ugly
  const gpt432kLockout = keyPool.getLockoutPeriod("gpt-4-32k");
  const gpt4Lockout = keyPool.getLockoutPeriod("gpt-4");
  const turboLockout = keyPool.getLockoutPeriod("gpt-3.5-turbo");
  const claudeLockout = keyPool.getLockoutPeriod("claude-v1");
  const palmLockout = keyPool.getLockoutPeriod("text-bison-001");
  const awsClaudeLockout = keyPool.getLockoutPeriod("anthropic.claude-v2");

  const reqs: (Request | undefined)[] = [];
  if (gpt432kLockout === 0) {
    reqs.push(dequeue("gpt4-32k"));
  }
  if (gpt4Lockout === 0) {
    reqs.push(dequeue("gpt4"));
  }
  if (turboLockout === 0) {
    reqs.push(dequeue("turbo"));
  }
  if (claudeLockout === 0) {
    reqs.push(dequeue("claude"));
  }
  if (palmLockout === 0) {
    reqs.push(dequeue("bison"));
  }
  if (awsClaudeLockout === 0) {
    reqs.push(dequeue("aws-claude"));
  }

  reqs.filter(Boolean).forEach((req) => {
    if (req?.proceed) {
      req.log.info({ retries: req.retryCount }, `Dequeuing request.`);
      req.proceed();
    }
  });
  setTimeout(processQueue, 50);
}

/**
 * Kill stalled requests after 5 minutes, and remove tracked wait times after 2
 * minutes.
 **/
function cleanQueue() {
  const now = Date.now();
  const oldRequests = queue.filter(
    (req) => now - (req.startTime ?? now) > 5 * 60 * 1000
  );
  oldRequests.forEach((req) => {
    req.log.info(`Removing request from queue after 5 minutes.`);
    killQueuedRequest(req);
  });

  const index = waitTimes.findIndex(
    (waitTime) => now - waitTime.end > 300 * 1000
  );
  const removed = waitTimes.splice(0, index + 1);
  log.trace(
    { stalledRequests: oldRequests.length, prunedWaitTimes: removed.length },
    `Cleaning up request queue.`
  );
  setTimeout(cleanQueue, 20 * 1000);
}

export function start() {
  processQueue();
  cleanQueue();
  log.info(`Started request queue.`);
}

let waitTimes: {
  partition: ModelFamily;
  start: number;
  end: number;
  isDeprioritized: boolean;
}[] = [];

/** Adds a successful request to the list of wait times. */
export function trackWaitTime(req: Request) {
  waitTimes.push({
    partition: getPartitionForRequest(req),
    start: req.startTime!,
    end: req.queueOutTime ?? Date.now(),
    isDeprioritized: isFromSharedIp(req),
  });
}

/**
 * Returns average wait time for the given queue partition in milliseconds.
 * Requests which are deprioritized are not included in the calculation as they
 * would skew the results due to their longer wait times.
 */
export function getEstimatedWaitTime(partition: ModelFamily) {
  const now = Date.now();
  const recentWaits = waitTimes.filter((wait) => {
    const isSamePartition = wait.partition === partition;
    const isRecent = now - wait.end < 300 * 1000;
    const isNormalPriority = !wait.isDeprioritized;
    return isSamePartition && isRecent && isNormalPriority;
  });
  if (recentWaits.length === 0) {
    return 0;
  }

  return (
    recentWaits.reduce((sum, wait) => sum + wait.end - wait.start, 0) /
    recentWaits.length
  );
}

export function getQueueLength(partition: ModelFamily | "all" = "all") {
  if (partition === "all") {
    return queue.length;
  }
  const modelQueue = getQueueForPartition(partition);
  return modelQueue.length;
}

export function createQueueMiddleware({
  beforeProxy,
  proxyMiddleware,
}: {
  beforeProxy?: RequestPreprocessor;
  proxyMiddleware: Handler;
}): Handler {
  return (req, res, next) => {
    req.proceed = async () => {
      if (beforeProxy) {
        // Hack to let us run asynchronous middleware before the
        // http-proxy-middleware handler. This is used to sign AWS requests
        // before they are proxied, as the signing is asynchronous.
        // Unlike RequestPreprocessors, this runs every time the request is
        // dequeued, not just the first time.
        await beforeProxy(req);
      }
      proxyMiddleware(req, res, next);
    };

    try {
      enqueue(req);
    } catch (err: any) {
      req.res!.status(429).json({
        type: "proxy_error",
        message: err.message,
        stack: err.stack,
        proxy_note: `Only one request can be queued at a time. If you don't have another request queued, your IP or user token might be in use by another request.`,
      });
    }
  };
}

function killQueuedRequest(req: Request) {
  if (!req.res || req.res.writableEnded) {
    req.log.warn(`Attempted to terminate request that has already ended.`);
    return;
  }
  const res = req.res;
  try {
    const message = `Your request has been terminated by the proxy because it has been in the queue for more than 5 minutes. The queue is currently ${queue.length} requests long.`;
    if (res.headersSent) {
      const fakeErrorEvent = buildFakeSse("proxy queue error", message, req);
      res.write(fakeErrorEvent);
      res.end();
    } else {
      res.status(500).json({ error: message });
    }
  } catch (e) {
    req.log.error(e, `Error killing stalled request.`);
  }
}

function initStreaming(req: Request) {
  const res = req.res!;
  initializeSseStream(res);

  if (req.query.badSseParser) {
    // Some clients have a broken SSE parser that doesn't handle comments
    // correctly. These clients can pass ?badSseParser=true to
    // disable comments in the SSE stream.
    return;
  }

  res.write(`: joining queue at position ${queue.length}\n\n`);
}

/**
 * http-proxy-middleware attaches a bunch of event listeners to the req and
 * res objects which causes problems with our approach to re-enqueuing failed
 * proxied requests. This function removes those event listeners.
 * We don't have references to the original event listeners, so we have to
 * look through the list and remove HPM's listeners by looking for particular
 * strings in the listener functions. This is an astoundingly shitty way to do
 * this, but it's the best I can come up with.
 */
function removeProxyMiddlewareEventListeners(req: Request) {
  // node_modules/http-proxy-middleware/dist/plugins/default/debug-proxy-errors-plugin.js:29
  // res.listeners('close')
  const RES_ONCLOSE = `Destroying proxyRes in proxyRes close event`;
  // node_modules/http-proxy-middleware/dist/plugins/default/debug-proxy-errors-plugin.js:19
  // res.listeners('error')
  const RES_ONERROR = `Socket error in proxyReq event`;
  // node_modules/http-proxy/lib/http-proxy/passes/web-incoming.js:146
  // req.listeners('aborted')
  const REQ_ONABORTED = `proxyReq.abort()`;
  // node_modules/http-proxy/lib/http-proxy/passes/web-incoming.js:156
  // req.listeners('error')
  const REQ_ONERROR = `if (req.socket.destroyed`;

  const res = req.res!;

  const resOnClose = res
    .listeners("close")
    .find((listener) => listener.toString().includes(RES_ONCLOSE));
  if (resOnClose) {
    res.removeListener("close", resOnClose as any);
  }

  const resOnError = res
    .listeners("error")
    .find((listener) => listener.toString().includes(RES_ONERROR));
  if (resOnError) {
    res.removeListener("error", resOnError as any);
  }

  const reqOnAborted = req
    .listeners("aborted")
    .find((listener) => listener.toString().includes(REQ_ONABORTED));
  if (reqOnAborted) {
    req.removeListener("aborted", reqOnAborted as any);
  }

  const reqOnError = req
    .listeners("error")
    .find((listener) => listener.toString().includes(REQ_ONERROR));
  if (reqOnError) {
    req.removeListener("error", reqOnError as any);
  }
}
