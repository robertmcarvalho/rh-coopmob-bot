from typing import Dict, Any, List

QUESTOES = [
    {"id": "pontualidade", "pergunta": "Você consegue chegar no ponto de apoio no horário combinado diariamente? (sempre/às vezes/raramente)"},
    {"id": "epi_uniforme", "pergunta": "Você topa usar uniforme completo e bag conforme padronização da farmácia? (sim/não)"},
    {"id": "rotas_app", "pergunta": "Você se sente confortável em seguir rotas pelo app e manter comunicação no chat? (sim/não/parcial)"},
    {"id": "finais_semana", "pergunta": "Você tem disponibilidade para pelo menos um turno em finais de semana? (sim/não)"},
    {"id": "boas_praticas", "pergunta": "Em situação de atraso, você avisa a equipe com antecedência? (sempre/às vezes/nunca)"},
]

MAPA = {"sim": 2, "sempre": 2, "às vezes": 1, "as vezes": 1, "parcial": 1, "não": 0, "nao": 0, "raramente": 0, "nunca": 0}
LIMIAR_APROVACAO = 7

def start_assessment() -> Dict[str, Any]:
    return {"perguntas": QUESTOES}

def score_assessment(respostas: Dict[str, str]) -> Dict[str, Any]:
    total = 0
    detalhado: List[Dict[str, Any]] = []
    for q in QUESTOES:
        rid = q["id"]
        txt = (respostas.get(rid,"") or "").strip().lower()
        pts = MAPA.get(txt, 0)
        detalhado.append({"id": rid, "resposta": txt, "pontos": pts})
        total += pts
    aprovado = total >= LIMIAR_APROVACAO
    return {"total": total, "aprovado": aprovado, "detalhado": detalhado, "limiar": LIMIAR_APROVACAO}
