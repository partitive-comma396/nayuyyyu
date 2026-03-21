"""
FastAPI server for Codex2API.

This module provides the main FastAPI application with OpenAI-compatible endpoints.
"""

import json
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional, Union

import httpx
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from .request import ChatGPTRequestHandler, CHATGPT_RESPONSES_URL, BASE_INSTRUCTIONS

# Load environment variables from .env file
load_dotenv()

# Security
security = HTTPBearer()


def verify_api_key(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """Verify API key from Authorization header."""
    expected_key = os.getenv("KEY", "sk-test")

    if not credentials:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    # Extract the key from "Bearer sk-xxx" format
    provided_key = credentials.credentials

    if provided_key != expected_key:
        raise HTTPException(status_code=401, detail="Invalid API key")

    return provided_key


def load_models_from_file() -> List[Dict[str, Any]]:
    """Load models from models.json file."""
    models_paths = [
        "models.json",  # Current directory
        os.path.join(os.path.dirname(__file__), "..", "models.json"),  # Parent directory
    ]

    for path in models_paths:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                models = data.get("models", [])
                # Convert to OpenAI API format while preserving extra capability fields.
                normalized_models: List[Dict[str, Any]] = []
                for model in models:
                    model_id = model.get("id", model.get("name", "unknown"))
                    item: Dict[str, Any] = {
                        "id": model_id,
                        "object": "model",
                        "owned_by": "openai",
                    }
                    if isinstance(model, dict):
                        for key in ("input", "output", "modalities", "capabilities"):
                            if key in model:
                                item[key] = model[key]
                    normalized_models.append(item)
                return normalized_models
        except FileNotFoundError:
            continue
        except Exception as e:
            print(f"Warning: Failed to read models file {path}: {e}")
            continue

    # Fallback to default models if file not found
    return [
        {"id": "gpt-5", "object": "model", "owned_by": "openai"},
        {"id": "gpt-4o", "object": "model", "owned_by": "openai"},
        {"id": "gpt-4", "object": "model", "owned_by": "openai"},
        {"id": "gpt-3.5-turbo", "object": "model", "owned_by": "openai"},
    ]


# Request/Response Models — extra="allow" prevents 422 on unknown fields
class ChatMessage(BaseModel):
    model_config = {"extra": "allow"}
    role: str
    content: Optional[Any] = None
    name: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None
    tool_call_id: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    model_config = {"extra": "allow"}
    model: str
    messages: List[ChatMessage]
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    n: Optional[int] = None
    stream: Optional[bool] = False
    stop: Optional[Union[str, List[str]]] = None
    max_tokens: Optional[int] = None
    presence_penalty: Optional[float] = None
    frequency_penalty: Optional[float] = None
    logit_bias: Optional[Dict[str, float]] = None
    user: Optional[str] = None
    tools: Optional[List[Dict[str, Any]]] = None
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None
    parallel_tool_calls: Optional[bool] = True
    reasoning: Optional[Dict[str, Any]] = None


class CompletionRequest(BaseModel):
    model_config = {"extra": "allow"}
    model: str
    prompt: Union[str, List[str]]
    suffix: Optional[str] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    n: Optional[int] = None
    stream: Optional[bool] = False
    logprobs: Optional[int] = None
    echo: Optional[bool] = False
    stop: Optional[Union[str, List[str]]] = None
    presence_penalty: Optional[float] = None
    frequency_penalty: Optional[float] = None
    best_of: Optional[int] = None
    logit_bias: Optional[Dict[str, float]] = None
    user: Optional[str] = None
    reasoning: Optional[Dict[str, Any]] = None


# Global request handler
request_handler: Optional[ChatGPTRequestHandler] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifespan."""
    global request_handler
    request_handler = ChatGPTRequestHandler(verbose=True)
    yield
    if request_handler:
        await request_handler.close()


def create_app(
    cors_origins: Optional[List[str]] = None,
    reasoning_effort: Optional[str] = None,
    reasoning_summary: Optional[bool] = None,
    reasoning_compat: Optional[str] = None,
) -> FastAPI:
    """Create and configure FastAPI application."""

    # Use environment variables with fallbacks
    if cors_origins is None:
        cors_origins = ["*"]
    if reasoning_effort is None:
        reasoning_effort = os.getenv("REASONING_EFFORT", "medium")
    if reasoning_summary is None:
        reasoning_summary = os.getenv("REASONING_SUMMARY", "true").lower() == "true"
    if reasoning_compat is None:
        reasoning_compat = os.getenv("REASONING_COMPAT", "think-tags")

    app = FastAPI(
        title="Codex2API",
        description="OpenAI compatible API powered by your ChatGPT plan",
        version="0.2.0",
        lifespan=lifespan,
    )

    # Add CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Store configuration
    app.state.reasoning_effort = reasoning_effort
    app.state.reasoning_summary = reasoning_summary
    app.state.reasoning_compat = reasoning_compat

    @app.get("/")
    async def root():
        """Root endpoint."""
        return {"message": "Codex2API - OpenAI compatible API powered by your ChatGPT plan"}

    @app.get("/health")
    async def health():
        """Health check endpoint."""
        return {"status": "healthy", "timestamp": int(time.time())}

    @app.get("/v1/accounts")
    async def list_accounts():
        """List all loaded accounts and their status."""
        from .multi_auth import account_manager
        return {"accounts": account_manager.get_status(), "total": account_manager.count}

    @app.get("/v1/models")
    async def list_models():
        """List available models from models.json file."""
        models = load_models_from_file()
        return {
            "object": "list",
            "data": models,
        }

    @app.post("/v1/chat/completions")
    async def chat_completions(
        request_data: ChatCompletionRequest, api_key: str = Depends(verify_api_key)
    ):
        """Handle chat completion requests."""
        if not request_handler:
            raise HTTPException(status_code=500, detail="Request handler not initialized")

        try:
            # Convert messages to dict format
            messages = [msg.model_dump() for msg in request_data.messages]

            upstream, response_data = await request_handler.chat_completion(
                model=request_data.model,
                messages=messages,
                stream=request_data.stream or False,
                tools=request_data.tools,
                tool_choice=request_data.tool_choice,
                parallel_tool_calls=request_data.parallel_tool_calls or False,
                reasoning_overrides=request_data.reasoning,
                max_completion_tokens=getattr(request_data, "max_completion_tokens", None),
                max_tokens=request_data.max_tokens,
                response_format=getattr(request_data, "response_format", None),
                seed=getattr(request_data, "seed", None),
                service_tier=getattr(request_data, "service_tier", None),
                previous_response_id=getattr(request_data, "previous_response_id", None),
            )

            if request_data.stream:
                # Return streaming response
                if upstream is None:
                    raise HTTPException(status_code=500, detail="Failed to get streaming response")
                return StreamingResponse(
                    request_handler.stream_chat_completion(
                        upstream,
                        request_handler._normalize_model_name(request_data.model),
                        reasoning_compat=app.state.reasoning_compat,
                    ),
                    media_type="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                    },
                )
            else:
                # Return non-streaming response
                if response_data is None:
                    raise HTTPException(status_code=500, detail="Failed to get response data")
                return JSONResponse(content=response_data)

        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

    @app.post("/v1/admin/check-drop")
    async def admin_check_drop(
        request: Request, api_key: str = Depends(verify_api_key)
    ):
        """一键检测指定账号是否掉车（用 gpt-5.4 xhigh 发一条请求）。body 可选: {"emails": ["a@b.com"]}，不传则检测所有已加载账号。"""
        from .multi_auth import account_manager

        emails = []
        try:
            body = await request.json()
            if isinstance(body, dict):
                emails = body.get("emails") or []
        except Exception:
            pass
        if not emails:
            emails = [a.get("email") for a in account_manager.get_status() if a.get("email")]

        def _classify_error(status_code: int, msg: str) -> str:
            """对检测失败结果分类：banned / quota_exhausted / dropped"""
            s = msg.lower()
            # 封号：登录失败（401/403），或明确的 auth 错误
            if status_code in (401, 403):
                return "banned"
            if "unauthorized" in s or "invalid token" in s or "access denied" in s or "forbidden" in s:
                return "banned"
            # 额度耗尽：5h 限额触发，不是账号故障
            if (
                "429" in s
                or "rate limit" in s
                or "too many requests" in s
                or "usage limit" in s
                or "quota" in s
                or "exceeded" in s
            ):
                return "quota_exhausted"
            # 其余（plan 降级、model not supported 等）= 掉车
            return "dropped"

        results = []
        for email in emails:
            if not email:
                continue
            acct = account_manager.get_account_by_email(email)
            if not acct:
                results.append({"email": email, "ok": False, "reason": "dropped", "error": "account_not_loaded"})
                continue
            try:
                _, _ = await request_handler.chat_completion(
                    model="gpt-5.4",
                    messages=[{"role": "user", "content": "hi"}],
                    stream=False,
                    reasoning_overrides={"effort": "xhigh"},
                    account_override=acct,
                )
                # 请求成功：清除额度限制标记
                acct.quota_reset_at = None
                results.append({"email": email, "ok": True})
            except HTTPException as e:
                detail = e.detail if isinstance(e.detail, str) else str(e.detail)
                reason = _classify_error(e.status_code, detail)
                if reason == "quota_exhausted":
                    reset_at = account_manager._extract_resets_at(detail) or (time.time() + 5 * 3600)
                    acct.quota_reset_at = reset_at
                    results.append({
                        "email": email, "ok": "quota_exhausted",
                        "quota_reset_at": reset_at, "error": detail,
                    })
                else:
                    acct.quota_reset_at = None
                    results.append({"email": email, "ok": False, "reason": reason, "error": detail})
            except Exception as e:
                err_str = str(e)
                reason = _classify_error(0, err_str)
                if reason == "quota_exhausted":
                    reset_at = account_manager._extract_resets_at(err_str) or (time.time() + 5 * 3600)
                    acct.quota_reset_at = reset_at
                    results.append({
                        "email": email, "ok": "quota_exhausted",
                        "quota_reset_at": reset_at, "error": err_str,
                    })
                else:
                    acct.quota_reset_at = None
                    results.append({"email": email, "ok": False, "reason": reason, "error": err_str})

        return JSONResponse(content={"results": results})

    @app.get("/v1/admin/quota")
    async def admin_quota(api_key: str = Depends(verify_api_key)):
        """返回已加载账号的基本信息（额度数据需通过 check_quota.js 浏览器方式获取）。"""
        from .multi_auth import account_manager
        import base64, json as _json

        def _decode_jwt(token: str) -> dict:
            try:
                payload = token.split(".")[1]
                payload += "=" * (-len(payload) % 4)
                return _json.loads(base64.b64decode(payload).decode("utf-8"))
            except Exception:
                return {}

        results = []
        for acct_info in account_manager.get_status():
            email = acct_info.get("email", "")
            acct = account_manager.get_account_by_email(email) if email else None
            entry: dict = {"email": email, "healthy": acct_info.get("healthy")}
            if acct:
                jwt_payload = _decode_jwt(acct.access_token or "")
                auth_claim = jwt_payload.get("https://api.openai.com/auth", {})
                entry["plan"] = auth_claim.get("chatgpt_plan_type")
            results.append(entry)

        return JSONResponse(content={"results": results})

    # ── Responses API (used by Codex desktop app) ──────────────────────

    def _extract_instruction_text(content: Any) -> str:
        """Flatten a Responses content payload into plain text instructions."""
        if isinstance(content, str):
            return content.strip()
        if not isinstance(content, list):
            return ""
        parts: List[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type in ("input_text", "output_text", "text"):
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        return "\n\n".join(parts)

    def _normalize_responses_input(input_data):
        """Normalize Responses API input to the format ChatGPT backend expects.

        Upstream codex responses rejects explicit `system` messages. We fold
        `system`/`developer` items into top-level instructions instead.
        """
        if isinstance(input_data, str):
            return (
                [{"type": "message", "role": "user",
                  "content": [{"type": "input_text", "text": input_data}]}],
                None,
            )
        if not isinstance(input_data, list):
            return [], None
        result = []
        instruction_chunks: List[str] = []
        for item in input_data:
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type and item_type != "message":
                result.append(item)
                continue
            role = item.get("role", "user")
            content = item.get("content", "")
            if role in ("system", "developer"):
                text = _extract_instruction_text(content)
                if text:
                    label = "SYSTEM" if role == "system" else "DEVELOPER"
                    instruction_chunks.append(f"[{label} MESSAGE]\n{text}")
                continue
            if isinstance(content, str):
                kind = "output_text" if role == "assistant" else "input_text"
                content = [{"type": kind, "text": content}]
            result.append({"type": "message", "role": role, "content": content})
        extra_instructions = "\n\n".join(instruction_chunks).strip() or None
        return result, extra_instructions

    MAX_RETRIES = 3

    async def _responses_upstream(payload: Dict[str, Any], upstream_url: str = CHATGPT_RESPONSES_URL) -> httpx.Response:
        """Send request to ChatGPT with retry + account rotation."""
        from .multi_auth import account_manager

        last_error = ""
        for attempt in range(MAX_RETRIES):
            headers = await request_handler._get_auth_headers()
            try:
                req = request_handler.client.build_request(
                    "POST", upstream_url, json=payload, headers=headers,
                )
                upstream = await request_handler.client.send(req, stream=True)
            except httpx.RequestError as e:
                if hasattr(request_handler, "_current_account") and request_handler._current_account:
                    account_manager.report_error(request_handler._current_account, str(e))
                last_error = f"Connection error: {e}"
                print(f"[RESPONSES] Attempt {attempt+1}/{MAX_RETRIES} failed: {e}")
                continue

            if upstream.status_code == 429 or upstream.status_code >= 500:
                error_body = (await upstream.aread()).decode("utf-8", errors="replace")
                await upstream.aclose()
                if hasattr(request_handler, "_current_account") and request_handler._current_account:
                    account_manager.report_error(request_handler._current_account, error_body)
                    acct_label = getattr(request_handler._current_account, 'label', '?')
                    print(f"[RESPONSES] {acct_label} → {upstream.status_code}, rotating to next account...")
                last_error = error_body
                continue

            if upstream.status_code >= 400:
                error_body = (await upstream.aread()).decode("utf-8", errors="replace")
                await upstream.aclose()
                if hasattr(request_handler, "_current_account") and request_handler._current_account:
                    account_manager.report_error(request_handler._current_account, error_body)
                raise HTTPException(status_code=upstream.status_code, detail=error_body)

            if hasattr(request_handler, "_current_account") and request_handler._current_account:
                account_manager.report_success(request_handler._current_account)
            return upstream

        raise HTTPException(status_code=502, detail=f"All {MAX_RETRIES} attempts failed: {last_error}")

    @app.post("/v1/responses")
    async def responses_api(request: Request, api_key: str = Depends(verify_api_key)):
        """Handle Responses API requests (Codex desktop app) with retry."""
        if not request_handler:
            raise HTTPException(status_code=500, detail="Request handler not initialized")

        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid request body")

        normalized_model = request_handler._normalize_model_name(body.get("model", "gpt-5.4"))
        input_items, extra_instructions = _normalize_responses_input(body.get("input", ""))
        reasoning = request_handler._build_reasoning_param(body.get("reasoning"))

        include = list(body.get("include", []))
        if reasoning.get("effort") != "none" and "reasoning.encrypted_content" not in include:
            include.append("reasoning.encrypted_content")

        instr = body.get("instructions")
        final_instructions = instr if instr is not None else BASE_INSTRUCTIONS
        if extra_instructions:
            final_instructions = f"{final_instructions}\n\n{extra_instructions}".strip()
        payload: Dict[str, Any] = {
            "model": normalized_model,
            "instructions": final_instructions,
            "input": input_items,
            "tools": body.get("tools", []),
            "tool_choice": body.get("tool_choice", "auto"),
            "parallel_tool_calls": bool(body.get("parallel_tool_calls", False)),
            "store": False,
            "stream": True,
            "include": include,
            "reasoning": reasoning,
        }

        svc = body.get("service_tier")
        if svc and svc != "default":
            payload["service_tier"] = svc
        elif os.getenv("FAST_MODE", "").lower() in ("true", "1", "on"):
            payload["service_tier"] = "priority"

        if body.get("previous_response_id"):
            payload["previous_response_id"] = body["previous_response_id"]
        for key in ("temperature", "top_p", "truncation"):
            if key in body:
                payload[key] = body[key]

        upstream = await _responses_upstream(payload)

        want_stream = body.get("stream", False)
        if want_stream:
            async def _passthrough():
                try:
                    async for raw_line in upstream.aiter_lines():
                        yield f"{raw_line}\n"
                except httpx.ReadError as e:
                    err_evt = {"type": "error", "error": {"message": str(e), "type": "server_error"}}
                    yield f"event: error\ndata: {json.dumps(err_evt)}\n\n"
                except Exception as e:
                    err_evt = {"type": "error", "error": {"message": str(e), "type": "server_error"}}
                    yield f"event: error\ndata: {json.dumps(err_evt)}\n\n"
                finally:
                    await upstream.aclose()

            return StreamingResponse(
                _passthrough(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                         "X-Accel-Buffering": "no"},
            )
        else:
            created = int(time.time())
            resp_id = f"resp_{created}"
            completed_response = None
            full_text = ""
            output_items: List[Dict[str, Any]] = []
            error_info = None

            try:
                async for raw_line in upstream.aiter_lines():
                    if not raw_line:
                        continue
                    line = raw_line.strip()
                    if not line.startswith("data: "):
                        continue
                    data_str = line[len("data: "):].strip()
                    if not data_str or data_str == "[DONE]":
                        continue
                    try:
                        evt = json.loads(data_str)
                    except Exception:
                        continue
                    kind = evt.get("type")
                    if kind == "response.created":
                        resp_id = evt.get("response", {}).get("id", resp_id)
                    elif kind == "response.output_text.delta":
                        full_text += evt.get("delta", "")
                    elif kind == "response.output_item.done":
                        item = evt.get("item")
                        if item:
                            output_items.append(item)
                    elif kind == "response.completed":
                        completed_response = evt.get("response", {})
                        break
                    elif kind == "response.failed":
                        error_info = evt.get("response", {}).get("error", {})
                        break
            finally:
                await upstream.aclose()

            if error_info:
                raise HTTPException(
                    status_code=502, detail=error_info.get("message", "response.failed"))

            if completed_response:
                return JSONResponse(content=completed_response)

            if not output_items and full_text:
                output_items = [{
                    "type": "message", "role": "assistant",
                    "content": [{"type": "output_text", "text": full_text}],
                    "status": "completed",
                }]
            return JSONResponse(content={
                "id": resp_id, "object": "response",
                "created_at": created, "model": normalized_model,
                "status": "completed", "output": output_items,
            })

    @app.post("/v1/responses/{response_id}/cancel")
    async def cancel_response(response_id: str, api_key: str = Depends(verify_api_key)):
        """Cancel an in-progress response."""
        if not request_handler:
            raise HTTPException(status_code=500, detail="Request handler not initialized")
        headers = await request_handler._get_auth_headers()
        try:
            resp = await request_handler.client.post(
                f"https://chatgpt.com/backend-api/codex/responses/{response_id}/cancel",
                headers=headers,
            )
            if resp.status_code < 400:
                return JSONResponse(content=resp.json())
        except Exception:
            pass
        return JSONResponse(content={
            "id": response_id, "object": "response",
            "status": "cancelled",
        })

    # ── Responses sub-paths (compact, etc.) ─────────────────────────────

    async def _responses_subpath_handler(request: Request, subpath: str):
        """Generic handler for /v1/responses/<subpath> — pure pass-through."""
        if not request_handler:
            raise HTTPException(status_code=500, detail="Request handler not initialized")
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid request body")

        if "model" in body:
            body["model"] = request_handler._normalize_model_name(body["model"])
        if "input" in body:
            input_items, extra_instructions = _normalize_responses_input(body["input"])
            body["input"] = input_items
            if extra_instructions:
                existing = body.get("instructions") or BASE_INSTRUCTIONS
                body["instructions"] = f"{existing}\n\n{extra_instructions}".strip()
        body.setdefault("instructions", BASE_INSTRUCTIONS)

        from .multi_auth import account_manager
        target_url = CHATGPT_RESPONSES_URL.rstrip("/") + "/" + subpath
        headers = await request_handler._get_auth_headers()

        try:
            resp = await request_handler.client.post(target_url, headers=headers, json=body)
        except httpx.RequestError as e:
            if hasattr(request_handler, "_current_account") and request_handler._current_account:
                account_manager.report_error(request_handler._current_account, str(e))
            raise HTTPException(status_code=502, detail=str(e))

        if hasattr(request_handler, "_current_account") and request_handler._current_account:
            if resp.status_code < 400:
                account_manager.report_success(request_handler._current_account)
            else:
                account_manager.report_error(request_handler._current_account, resp.text[:200])

        return JSONResponse(content=resp.json(), status_code=resp.status_code)

    @app.post("/v1/responses/compact")
    async def responses_compact(request: Request, api_key: str = Depends(verify_api_key)):
        return await _responses_subpath_handler(request, "compact")

    @app.post("/v1/responses/{response_id}/{action}")
    async def responses_action(response_id: str, action: str, request: Request, api_key: str = Depends(verify_api_key)):
        """Catch-all for /v1/responses/{id}/{action} paths."""
        if action == "cancel":
            return await cancel_response(response_id, api_key)
        if not request_handler:
            raise HTTPException(status_code=500, detail="Request handler not initialized")
        headers = await request_handler._get_auth_headers()
        try:
            body = await request.json()
        except Exception:
            body = {}
        try:
            resp = await request_handler.client.post(
                f"https://chatgpt.com/backend-api/codex/responses/{response_id}/{action}",
                headers=headers, json=body,
            )
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e))

    # ── Embeddings (local, for Mem0 etc.) ───────────────────────────────

    _embed_model = None

    def _get_embed_model():
        nonlocal _embed_model
        if _embed_model is None:
            from fastembed import TextEmbedding
            print("📦 Loading embeddings model (first time downloads ~640MB)...")
            _embed_model = TextEmbedding("jinaai/jina-embeddings-v2-base-zh")
            print("✅ Embeddings model ready (jina-zh, 768d, 8192 tokens)")
        return _embed_model

    @app.post("/v1/embeddings")
    async def embeddings(request: Request, api_key: str = Depends(verify_api_key)):
        """Local embeddings endpoint (OpenAI-compatible)."""
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid request body")

        input_data = body.get("input", "")
        if isinstance(input_data, str):
            texts = [input_data]
        elif isinstance(input_data, list):
            texts = [t if isinstance(t, str) else str(t) for t in input_data]
        else:
            texts = [str(input_data)]

        model = _get_embed_model()
        vectors = list(model.embed(texts))

        data = []
        total_tokens = 0
        for i, vec in enumerate(vectors):
            data.append({
                "object": "embedding",
                "index": i,
                "embedding": vec.tolist(),
            })
            total_tokens += len(texts[i].split()) * 2

        return JSONResponse(content={
            "object": "list",
            "data": data,
            "model": body.get("model", "text-embedding-local"),
            "usage": {"prompt_tokens": total_tokens, "total_tokens": total_tokens},
        })

    @app.exception_handler(HTTPException)
    async def openai_error_format(request: Request, exc: HTTPException):
        """Return errors in OpenAI standard format."""
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"message": detail, "type": "server_error", "code": exc.status_code}},
        )

    @app.post("/v1/completions")
    async def completions(request_data: CompletionRequest, api_key: str = Depends(verify_api_key)):
        """Handle text completion requests."""
        if not request_handler:
            raise HTTPException(status_code=500, detail="Request handler not initialized")

        try:
            # Handle prompt format
            prompt = request_data.prompt
            if isinstance(prompt, list):
                prompt = "".join([p if isinstance(p, str) else "" for p in prompt])
            if not isinstance(prompt, str):
                prompt = ""

            upstream, response_data = await request_handler.text_completion(
                model=request_data.model,
                prompt=prompt,
                stream=request_data.stream or False,
                reasoning_overrides=request_data.reasoning,
            )

            if request_data.stream:
                # Return streaming response
                if upstream is None:
                    raise HTTPException(status_code=500, detail="Failed to get streaming response")
                return StreamingResponse(
                    request_handler.stream_text_completion(
                        upstream, request_handler._normalize_model_name(request_data.model)
                    ),
                    media_type="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                    },
                )
            else:
                # Return non-streaming response
                if response_data is None:
                    raise HTTPException(status_code=500, detail="Failed to get response data")
                return JSONResponse(content=response_data)

        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

    return app
