# OpenAI-compatible API

`piren gateway` exposes a minimal OpenAI-compatible chat completions endpoint for clients such as Open WebUI.

## Endpoint

```text
POST /api/v1/chat/completions
```

It inherits the same `/api/*` Bearer auth gate as the rest of the gateway when a token is configured.

## Request

```json
{
  "model": "piren/default",
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "stream": false
}
```

`messages` are flattened into a prompt for the current Piren agent. The optional `model` field is accepted for client compatibility. Piren's integrated UI does not expose model controls.

## Non-streaming response

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "piren/default",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ]
}
```

## Streaming response

Set:

```json
{ "stream": true }
```

The route returns `text/event-stream` with OpenAI-style chunk frames:

```text
data: {"object":"chat.completion.chunk",...}

data: [DONE]
```

## Scope

This endpoint is intended for external clients. The integrated Piren web UI stays minimal and uses Piren-native chat routes.
