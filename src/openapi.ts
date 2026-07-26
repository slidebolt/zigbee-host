export const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {title: "Slidebolt Zigbee Host API", version: "1.0.0"},
  security: [{bearerAuth: []}],
  paths: {
    "/v1/health": {get: {operationId: "getHealth", responses: {"200": {description: "Host health"}}}},
    "/v1/snapshot": {get: {operationId: "getSnapshot", responses: {"200": {description: "Atomic coordinator and device snapshot"}}}},
    "/v1/events": {get: {operationId: "streamEvents", parameters: [
      {name: "streamId", in: "query", schema: {type: "string"}},
      {name: "after", in: "query", schema: {type: "integer", minimum: 0}},
    ], responses: {"200": {description: "Replay followed by live events", content: {"text/event-stream": {}}}, "409": {$ref: "#/components/responses/problem"}}}},
    "/v1/devices": {get: {operationId: "listDevices", responses: {"200": {description: "Paired devices"}}}},
    "/v1/devices/{deviceId}": {get: {operationId: "getDevice", parameters: [{$ref: "#/components/parameters/deviceId"}], responses: {"200": {description: "Device"}}}},
    "/v1/devices/{deviceId}/components/{componentId}/commands": {post: {
      operationId: "submitComponentCommand",
      parameters: [{$ref: "#/components/parameters/deviceId"}, {name: "componentId", in: "path", required: true, schema: {type: "string"}}],
      requestBody: {required: true, content: {"application/json": {schema: {type: "object", required: ["action"], properties: {action: {type: "string"}, parameters: {type: "object"}, requestId: {type: "string"}, observationTimeoutMs: {type: "integer"}}}}}},
      responses: {"202": {description: "Command queued"}, "404": {$ref: "#/components/responses/problem"}},
    }},
    "/v1/commands/{commandId}": {get: {operationId: "getCommand", parameters: [{name: "commandId", in: "path", required: true, schema: {type: "string"}}], responses: {"200": {description: "Command status"}}}},
    "/v1/pairing": {get: {operationId: "getPairing", responses: {"200": {description: "Pairing status"}}}},
    "/v1/pairing/config": {patch: {operationId: "configurePairing", responses: {"200": {description: "Pairing configuration"}}}},
    "/v1/pairing/start": {post: {operationId: "startPairing", responses: {"202": {description: "Pairing started"}}}},
    "/v1/pairing/stop": {post: {operationId: "stopPairing", responses: {"202": {description: "Pairing stopped"}}}},
  },
  components: {
    securitySchemes: {bearerAuth: {type: "http", scheme: "bearer"}},
    parameters: {deviceId: {name: "deviceId", in: "path", required: true, schema: {type: "string", pattern: "^0x[0-9a-fA-F]{16}$"}}},
    responses: {problem: {description: "Problem response", content: {"application/json": {schema: {type: "object"}}}}},
  },
} as const;
