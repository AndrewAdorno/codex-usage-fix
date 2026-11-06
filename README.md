# Codex Usage Fix

Extensão Chrome (MV3) que troca "X% restante(s)" por "Y% usado" nos limites de 5 horas e semanal em
`chatgpt.com/settings/usage`.

## Instalação
1. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
2. **Carregar sem compactação** e selecione esta pasta.
3. Abra https://chatgpt.com/settings/usage e atualize a página.

## Como funciona
- Não altera o texto original (o React o reverteria). Os elementos originais ficam com `opacity:0` e
  uma camada em Shadow DOM, fixa no `<body>`, é desenhada exatamente por cima.
- Lê o valor do `<progress>` original a cada frame: atualização em tempo real.
- A barra passa a encher conforme o uso; fica âmbar a partir de 70% e vermelha a partir de 90%.
- Para voltar ao comportamento original, desative a extensão.

## Observação
O número grande em "Uso recente do plano" não é alterado.
