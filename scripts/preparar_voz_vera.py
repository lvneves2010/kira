"""Baixa e prepara a voz "Vera" (Pocket TTS português) para o app Android.

A voz roda offline no celular com o sherpa-onnx. Os arquivos são grandes
(~107 MB de modelo + ~49 MB de biblioteca), por isso ficam fora do git
(ver .gitignore) e este script os recria:

- android/app/libs/sherpa-onnx-<versão>.aar        biblioteca nativa do sherpa-onnx
- android/app/src/main/assets/vera/*.onnx, *.json  modelo no layout do sherpa-onnx
- android/app/src/main/assets/vera/referencia.wav  amostra da voz Vera (clonagem)

Uso (uma vez por máquina, e de novo se mudar a versão):
    python -m venv .venv-voz
    .venv-voz/Scripts/python -m pip install onnx sentencepiece numpy
    .venv-voz/Scripts/python scripts/preparar_voz_vera.py

Licenças: pesos do Pocket TTS © Kyutai Labs, CC BY 4.0 (conversão int4 por
Prasad Vittaldev, também CC BY 4.0); sherpa-onnx, Apache 2.0. O crédito
aparece no app, no menu de configurações.
"""
import json
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import onnx
import sentencepiece as spm
from onnx import helper, numpy_helper

VERSAO_SHERPA = "2.0.1"
URL_AAR = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/v{VERSAO_SHERPA}/sherpa-onnx-{VERSAO_SHERPA}.aar"
URL_MODELO = "https://huggingface.co/prasadvittaldev/pocket-tts-portuguese-onnx-int4/resolve/main"
ARQUIVOS_MODELO = [
    "flow_lm_flow_int8.onnx",
    "flow_lm_main_int4.onnx",
    "mimi_decoder_int8.onnx",
    "mimi_encoder_int8.onnx",
    "text_conditioner.onnx",
    "tokenizer.model",
    "bos_before_voice.npy",
    "sample_vera.wav",
]

RAIZ = Path(__file__).resolve().parent.parent
DESTINO_AAR = RAIZ / "android" / "app" / "libs" / f"sherpa-onnx-{VERSAO_SHERPA}.aar"
DESTINO_MODELO = RAIZ / "android" / "app" / "src" / "main" / "assets" / "vera"


def baixar(url: str, destino: Path) -> None:
    if destino.exists() and destino.stat().st_size > 0:
        print(f"  já existe: {destino.name}")
        return
    print(f"  baixando {url.rsplit('/', 1)[-1]} ...")
    destino.parent.mkdir(parents=True, exist_ok=True)
    temporario = destino.with_suffix(destino.suffix + ".parcial")
    with urllib.request.urlopen(url) as resposta, open(temporario, "wb") as arquivo:
        shutil.copyfileobj(resposta, arquivo)
    temporario.replace(destino)


def encoder_com_bos(origem: Path, destino: Path) -> None:
    """O bundle português usa insert_bos_before_voice=true; o sherpa-onnx não
    insere o BOS sozinho, então ele vai embutido no grafo do encoder."""
    modelo = onnx.load(origem / "mimi_encoder_int8.onnx")
    saida = modelo.graph.output[0]
    nome = saida.name
    interno = nome + "_sem_bos"
    for no in modelo.graph.node:
        no.output[:] = [interno if o == nome else o for o in no.output]
    bos = np.load(origem / "bos_before_voice.npy").astype(np.float32).reshape(1, 1, -1)
    modelo.graph.initializer.append(numpy_helper.from_array(bos, name="bos_before_voice"))
    modelo.graph.node.append(helper.make_node("Concat", ["bos_before_voice", interno], [nome], axis=1))
    dimensoes = saida.type.tensor_type.shape.dim
    dimensoes[1].ClearField("dim_value")
    dimensoes[1].dim_param = "quadros_mais_bos"
    onnx.checker.check_model(modelo)
    onnx.save(modelo, destino / "encoder.onnx")


def tokenizador(origem: Path, destino: Path) -> None:
    sp = spm.SentencePieceProcessor(model_file=str(origem / "tokenizer.model"))
    total = sp.get_piece_size()
    vocab = {sp.id_to_piece(i): i for i in range(total)}
    scores = {sp.id_to_piece(i): float(sp.get_score(i)) for i in range(total)}
    (destino / "vocab.json").write_text(json.dumps(vocab, ensure_ascii=False), encoding="utf-8")
    (destino / "token_scores.json").write_text(json.dumps(scores, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    print("1/3 Biblioteca sherpa-onnx")
    baixar(URL_AAR, DESTINO_AAR)

    print("2/3 Modelo Pocket TTS português")
    with tempfile.TemporaryDirectory() as pasta:
        origem = Path(pasta)
        for nome in ARQUIVOS_MODELO:
            baixar(f"{URL_MODELO}/{nome}", origem / nome)

        print("3/3 Convertendo para o layout do sherpa-onnx")
        if DESTINO_MODELO.exists():
            shutil.rmtree(DESTINO_MODELO)
        DESTINO_MODELO.mkdir(parents=True)
        encoder_com_bos(origem, DESTINO_MODELO)
        tokenizador(origem, DESTINO_MODELO)
        for de, para in [
            ("flow_lm_flow_int8.onnx", "lm_flow.int8.onnx"),
            ("flow_lm_main_int4.onnx", "lm_main.int4.onnx"),
            ("mimi_decoder_int8.onnx", "decoder.int8.onnx"),
            ("text_conditioner.onnx", "text_conditioner.onnx"),
            ("sample_vera.wav", "referencia.wav"),
        ]:
            shutil.copyfile(origem / de, DESTINO_MODELO / para)

    total = sum(f.stat().st_size for f in DESTINO_MODELO.iterdir()) / 1e6
    print(f"Pronto: {DESTINO_MODELO} ({total:.0f} MB) e {DESTINO_AAR.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
