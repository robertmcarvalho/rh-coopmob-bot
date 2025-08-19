import os
from google.adk.agents import LlmAgent
from google.adk.tools import FunctionTool
from google.adk.callbacks import Callback
from .prompts import SYSTEM_PROMPT
from .tools.sheets import get_open_positions, save_lead, get_coop_info, get_position_by_id
from .tools.assessment import start_assessment, score_assessment
from .tools.requirements_check import check_requirements
from .tools.audio import transcribe_audio_url, transcribe_audio_base64
from .tools.whatsapp import send_vagas_list, send_text
from .tools.pipefy import get_pipefy_link
from .tools.memory import load_user_memory, save_user_memory

GENAI_MODEL = os.getenv("GENAI_MODEL", "gemini-2.0-flash")

async def before_agent_callback(event, session, runner):
    try:
        await load_user_memory(session=session)
    except Exception:
        pass

async def after_agent_callback(event, session, runner):
    try:
        await save_user_memory(session=session)
    except Exception:
        pass

callbacks = [Callback(before_agent=before_agent_callback, after_agent=after_agent_callback)]

agent = LlmAgent(
    name="coop_agent",
    model=GENAI_MODEL,
    instruction=SYSTEM_PROMPT,
    description="Agente de triagem de entregadores para cooperativa (Farmácias).",
    tools=[
        FunctionTool(func=load_user_memory),
        FunctionTool(func=save_user_memory),
        FunctionTool(func=get_open_positions),
        FunctionTool(func=get_position_by_id),
        FunctionTool(func=get_coop_info),
        FunctionTool(func=check_requirements),
        FunctionTool(func=start_assessment),
        FunctionTool(func=score_assessment),
        FunctionTool(func=save_lead),
        FunctionTool(func=transcribe_audio_url),
        FunctionTool(func=transcribe_audio_base64),
        FunctionTool(func=send_vagas_list),
        FunctionTool(func=send_text),
        FunctionTool(func=get_pipefy_link),
    ],
    callbacks=callbacks,
)
