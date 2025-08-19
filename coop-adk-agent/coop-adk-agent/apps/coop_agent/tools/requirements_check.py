from typing import Dict, Any

def check_requirements(moto_ok: bool, cnh_categoria_a: bool, android_ok: bool) -> Dict[str, Any]:
    faltantes = []
    if not moto_ok:
        faltantes.append("Moto com documentação em dia")
    if not cnh_categoria_a:
        faltantes.append("CNH categoria A")
    if not android_ok:
        faltantes.append("Dispositivo Android")
    return {"ok": len(faltantes)==0, "faltantes": faltantes}
