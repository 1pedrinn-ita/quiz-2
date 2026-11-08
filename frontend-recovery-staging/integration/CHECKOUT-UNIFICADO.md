# Checkout unificado de staging

O fluxo novo está em `/selecionar/` e é servido como página estática dentro da
cópia de staging. Os botões de compra da loja usam navegação de página completa
para essa rota, que grava as escolhas na sessão e encaminha ao checkout
TanStack existente.

## Dados e validação

- Os tamanhos são extraídos do catálogo recuperado: tênis 34–45; regata e
  shorts P/M/G.
- O kit continua sendo um único SKU (`corre-rosa-kit`) com preço de servidor
  R$ 97,90. Os tamanhos são validados no backend de staging e persistidos em
  `order_items` como `kit_sizes`; nenhum preço é dividido entre as peças.
- O CEP é consultado no ViaCEP, e o endereço encontrado é pré-preenchido no
  checkout. O número e o complemento continuam sendo informados na etapa de
  endereço do checkout.
- O front mostra as modalidades e prazos informados na solicitação: frete
  grátis (5–12 dias úteis) e standard (2–5 dias úteis). O catálogo recuperado
  registra R$ 8,45 para a modalidade Correios/expressa, valor mantido no card.
  Os novos prazos ainda precisam de confirmação logística antes de uso
  comercial; nenhum evento ou prazo foi obtido de uma transportadora.
- O valor expresso de R$ 8,45 deve corresponder ao SKU de frete configurado no
  catálogo de staging; o backend mantém o cálculo autoritativo.
- As rotas de pedido e pagamento continuam indisponíveis na prévia estática.
  O PIX local permanece simulado e não chama a PinguPag.

## Verificação visual

A folha inclui breakpoints para até 340 px e 600 px, cards empilhados em
celulares, campos com fonte de 16 px e imagens em `object-fit: contain`. Os
testes automatizados simulam seleções, bloqueio de tamanhos ausentes, consulta
de CEP, cálculo dos dois totais e envio dos dados de handoff. O screenshot
automatizado não pôde ser capturado porque o Edge headless encerrou com erro
fatal do processo gráfico deste ambiente; a inspeção visual final ainda deve
ser feita em navegador normal nas larguras 320, 360, 390, 430 px e desktop.
