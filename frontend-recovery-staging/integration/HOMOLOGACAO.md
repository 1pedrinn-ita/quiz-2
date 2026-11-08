# Relatório de preparação de homologação

Data: 2026-11-07

## Isolamento

- Esta árvore tem `netlify.toml`, funções e migrations próprios; não alterei a
  configuração Netlify de produção nem a branch `main`.
- `supabase/config.toml` usa o identificador local `quiz-2-staging` e portas
  locais. `.env.staging.example` aponta para `127.0.0.1` e contém placeholders,
  nunca credenciais.
- Nenhuma migration foi aplicada e nenhuma conexão a Supabase remoto foi feita.
- O PIX de staging é simulado; nenhum provedor de pagamento foi chamado.

## Verificações executadas

- 21 testes da integração de staging aprovados, incluindo a nova seleção
  unificada, bloqueio de tamanhos incompletos, consulta válida/inválida de CEP,
  cálculo de ambos os fretes e envio das escolhas ao checkout.
- 19 testes existentes do backend aprovados.
- Criação/idempotência de pedidos, cálculo pelo catálogo do servidor,
  endereço/CEP, consulta autenticada, códigos `CR-`, proteção contra PII,
  registro de eventos existentes, PIX simulado e confirmação simulada foram
  testados com dados fictícios e mocks.
- A migration de código de acesso passou validações estáticas: aditiva,
  idempotente, formato do hash, índice único parcial, permissões e par `$$`.
  Isso não substitui validação pelo PostgreSQL.
- O grafo local dos módulos JavaScript foi resolvido e as suítes de teste
  passaram. Não executei funções Netlify reais.
- A rota de staging `/selecionar/` serve HTML, CSS, JavaScript e imagens
  localmente. As APIs continuam deliberadamente em `503` na prévia estática.
- A captura visual da nova página não foi possível: o Edge headless encerrou
  por falha fatal do processo gráfico. Os breakpoints foram verificados por
  teste de stylesheet, mas as larguras 320/360/390/430 px e desktop ainda
  precisam de conferência visual em navegador normal.
- A folha original inclui viewport meta e breakpoints para telas menores.
  Uma captura de 390 px mostra o modal de tamanhos cortado horizontalmente:
  [checkout-mobile-390px.png](./reports/checkout-mobile-390px.png). O teste
  visual de pós-venda em desktop/mobile não foi concluído: a execução headless
  do Edge falhou por restrições do ambiente gráfico/GPU.

## Bloqueios para homologação ponta a ponta

Não há Supabase CLI nem `psql` instalado, o daemon Docker está indisponível,
não há CLI Netlify e nenhuma variável necessária está configurada. Portanto,
não pude iniciar banco local, aplicar migrations, chamar as funções com um
Supabase de staging, inspecionar logs Netlify ou executar o checkout real de
staging.

Para avançar sem usar produção, é necessário:

1. Disponibilizar um Supabase dedicado de staging (`SUPABASE_URL` e
   `SUPABASE_SERVICE_ROLE_KEY`) ou instalar/iniciar Supabase CLI e Docker para
   usar o stack local deste diretório.
2. Configurar nesse ambiente os segredos `CHECKOUT_TOKEN_SECRET`,
   `RATE_LIMIT_SECRET`, `ORDER_ACCESS_CODE_SECRET` e
   `ORDER_OPERATIONS_TOKEN` (cada um com pelo menos 32 bytes).
3. Configurar `PIX_ORDER_CATALOG_JSON` com os SKUs/valores documentados e
   `PIX_MAX_AMOUNT_CENTS=17605`; conferir o catálogo aprovado antes de testar.
4. Para confirmação de teste, habilitar `STAGING_SIMULATOR_ENABLED=true` e
   configurar `STAGING_SIMULATOR_SECRET` somente no ambiente isolado. Não é
   necessária credencial PinguPag.
5. Disponibilizar uma instalação autorizada do Netlify CLI para teste local,
   ou autorizar posteriormente um site Netlify de staging separado. Não usar
   o site de produção.
6. Corrigir e repetir a verificação de responsividade do modal de tamanhos;
   concluir a inspeção visual de pós-venda e console em navegador funcional.

Configure segredos diretamente no ambiente local/gerenciador de secrets; não
os envie no chat. Nenhum prazo ou evento logístico foi criado para esta auditoria.
