import requests, os
from typing import Dict, Any
from google import genai
from google.genai import types

MODEL = os.getenv("GENAI_MODEL", "gemini-2.0-flash")

def _client():
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY não definido.")
    return genai.Client(api_key=api_key)

def _transcribe_bytes(b: bytes, mime: str="audio/mpeg") -> str:
    client = _client()
    parts = [types.Part.from_bytes(data=b, mime_type=mime), types.Part.from_text("Transcreva em português do Brasil, apenas o texto falado.")]
    r = client.models.generate_content(model=MODEL, contents=[types.Content(role="user", parts=parts)])
    return r.text or ""

def transcribe_audio_url(url: str, mime_type: str="audio/mpeg") -> Dict[str, Any]:
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    texto = _transcribe_bytes(resp.content, mime=mime_type)
    return {"transcript": texto}

def transcribe_audio_base64(b64_data: str, mime_type: str="audio/mpeg") -> Dict[str, Any]:
    import base64
    raw = base64.b64decode(b64_data)
    texto = _transcribe_bytes(raw, mime=mime_type)
    return {"transcript": texto}
