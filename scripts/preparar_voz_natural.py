"""Baixa a voz natural da KIRA (Supertonic 2, int8) e a biblioteca sherpa-onnx para o app Android.

Os arquivos são grandes (~96 MB de modelo + ~49 MB de biblioteca), por isso ficam
fora do git (ver .gitignore). Este script os recria; sem eles o build do Android falha.

- android/app/libs/sherpa-onnx-<versão>.aar          biblioteca nativa do sherpa-onnx
- android/app/src/main/assets/supertonic/*            modelo Supertonic 2 int8 (layout do sherpa-onnx)

Uso (uma vez por máquina; só precisa de Python 3, sem pacotes extras):
    python scripts/preparar_voz_natural.py

Licenças: modelo Supertonic 2 © Supertone Inc. sob BigScience OpenRAIL-M (uso comercial
permitido, com restrições de uso que devem ser repassadas aos usuários); código MIT;
sherpa-onnx Apache 2.0. A licença do modelo vai junto em assets/supertonic/LICENSE-modelo.txt.
"""
import shutil
import sys
import urllib.request
from pathlib import Path

VERSAO_SHERPA = "2.0.1"
URL_AAR = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/v{VERSAO_SHERPA}/sherpa-onnx-{VERSAO_SHERPA}.aar"
URL_MODELO = "https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-tts-int8-2026-03-06/resolve/main"
ARQUIVOS_MODELO = [
    "duration_predictor.int8.onnx",
    "text_encoder.int8.onnx",
    "vector_estimator.int8.onnx",
    "vocoder.int8.onnx",
    "tts.json",
    "unicode_indexer.bin",
    "voice.bin",
]
URL_LICENCA_MODELO = "https://huggingface.co/Supertone/supertonic-2/resolve/main/LICENSE"

RAIZ = Path(__file__).resolve().parent.parent
DESTINO_AAR = RAIZ / "android" / "app" / "libs" / f"sherpa-onnx-{VERSAO_SHERPA}.aar"
DESTINO_MODELO = RAIZ / "android" / "app" / "src" / "main" / "assets" / "supertonic"


def baixar(url: str, destino: Path) -> None:
    if destino.exists() and destino.stat().st_size > 0:
        print(f"  já existe: {destino.name}")
        return
    print(f"  baixando {destino.name} ...")
    destino.parent.mkdir(parents=True, exist_ok=True)
    parcial = destino.with_name(destino.name + ".parcial")
    with urllib.request.urlopen(url) as resposta, open(parcial, "wb") as arquivo:
        shutil.copyfileobj(resposta, arquivo)
    parcial.replace(destino)


def main() -> int:
    print("1/2 Biblioteca sherpa-onnx")
    baixar(URL_AAR, DESTINO_AAR)

    print("2/2 Modelo Supertonic 2 (int8)")
    for nome in ARQUIVOS_MODELO:
        baixar(f"{URL_MODELO}/{nome}", DESTINO_MODELO / nome)
    baixar(URL_LICENCA_MODELO, DESTINO_MODELO / "LICENSE-modelo.txt")

    total = sum(f.stat().st_size for f in DESTINO_MODELO.iterdir()) / 1e6
    print(f"Pronto: {DESTINO_MODELO} ({total:.0f} MB) e {DESTINO_AAR.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
