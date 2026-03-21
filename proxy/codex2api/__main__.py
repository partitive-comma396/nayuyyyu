"""Entry point: python -m codex2api"""
import os
import uvicorn
from dotenv import load_dotenv
from .server import create_app

load_dotenv()

host = os.getenv("HOST", "0.0.0.0")
port = int(os.getenv("PORT", "9000"))

print(f"🚀 Codex2API on {host}:{port}")
app = create_app()
uvicorn.run(app, host=host, port=port, log_level="info")
