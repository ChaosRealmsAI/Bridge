import { legacyRuntimeApiRemovedPayload, isLegacyRuntimeRoute } from "./legacy-runtime.js";
import { createRouteTable, requestPath } from "./router.js";
import { createWorkerApp } from "./worker-app.js";
import {
  BridgeDeviceRoom,
  BridgeTestStore,
  __bridgeTestConnectorRelayListPayload,
  __bridgeTestMemorySnapshot,
  __bridgeTestRelayEnvelopeMatches,
  createWorkerHandlers,
  scheduled,
} from "./worker-core.js";

const handlers = createWorkerHandlers();
const routes = createRouteTable(handlers);
const legacyRuntimeRoute = (request, path) => isLegacyRuntimeRoute(request.method, path);
const legacyRuntimeApiRemoved = (env) => handlers.legacyRuntimeApiRemoved({
  env,
  payload: legacyRuntimeApiRemovedPayload(),
});

const worker = createWorkerApp({
  handlers,
  routes,
  requestPath,
  legacyRuntimeRoute,
  legacyRuntimeApiRemoved,
  scheduled,
});

export {
  BridgeDeviceRoom,
  BridgeTestStore,
  __bridgeTestConnectorRelayListPayload,
  __bridgeTestMemorySnapshot,
  __bridgeTestRelayEnvelopeMatches,
};

export default worker;
