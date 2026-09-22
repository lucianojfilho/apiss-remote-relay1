# apiss-remote-relay

Painel web para controlar o APISS pelo celular, de qualquer lugar. O APISS se
conecta a este serviço só para fora (nenhuma porta é aberta no seu
computador); o celular fala só com este serviço.

## Deploy no Render.com (gratuito, sem cartão de crédito)

Esta pasta já está pronta como repositório Git local (`git init` + primeiro
commit já feitos) e inclui um `render.yaml`, que o Render lê sozinho para
configurar tudo automaticamente.

1. Crie um repositório novo e **vazio** no GitHub (sem README, sem
   .gitignore, sem licença — esta pasta já traz os seus próprios) e suba
   esta pasta para ele:
   ```
   git remote add origin https://github.com/SEU-USUARIO/apiss-remote-relay.git
   git branch -M main
   git push -u origin main
   ```
2. Entre no Render (https://render.com) — pode usar a conta do Google.
3. No painel do Render, clique em **New +** → **Blueprint**, e conecte o
   repositório que você acabou de subir. O Render lê o `render.yaml` e já
   preenche runtime, build e start command sozinho — só falta o segredo.
4. Abra o APISS no seu computador, vá em **Outras ferramentas → Controle
   remoto** e copie o valor do campo **"Segredo do agente"** (o APISS já
   gera esse valor sozinho, na primeira vez que a aba é aberta).
5. Quando o Render pedir o valor de `AGENT_SECRET`, cole exatamente o valor
   copiado do APISS.
6. Confirme e aguarde o deploy (alguns minutos).
7. Quando concluir, o Render mostra uma URL pública, algo como
   `https://apiss-remote-relay.onrender.com`. Copie essa URL.

   (Se preferir não usar Blueprint, dá pra fazer manualmente em **New +** →
   **Web Service**: Runtime Node, Build Command `npm install`, Start Command
   `npm start`, e adicionar `AGENT_SECRET` em Environment Variables.)

## Configurando o APISS

No APISS, na mesma aba **Controle remoto**, cole a URL do Render no campo de
endereço e clique em Salvar.

## Entrando pelo celular

Abra a URL do Render no celular e cole o mesmo valor do **"Segredo do
agente"** (o mesmo que você usou no `AGENT_SECRET` do Render) no campo de
senha. Não existe pareamento por código nem expiração — é a mesma senha
sempre, guardada no navegador do celular, então normalmente você só faz isso
uma vez por aparelho/navegador.

## SUPER Sapiens direto (sem depender do APISS/PC)

Além do controle remoto do APISS, o relay tem um cliente próprio do SUPER
Sapiens (login, sincronizar tarefas, baixar PDF), que funciona mesmo com o
computador desligado. A sessão fica só em memória deste processo — some se
o Render reiniciar o serviço, exigindo login de novo pelo celular; nenhuma
senha ou código de 2FA é armazenado permanentemente.

Ao baixar um PDF por esse caminho, o botão **"Enviar ao Drive"** abre o
seletor de pastas do Google (usando a própria conta do usuário no
navegador — o relay nunca vê nem guarda esse acesso) e envia o PDF e o
`.md` convertido (sem OCR — só o texto já embutido no PDF) para a pasta
escolhida. Isso já vem configurado neste repositório com um projeto do
Google Cloud próprio; não precisa configurar nada a mais no Render para
isso funcionar (o Client ID OAuth e a chave de API do Drive são valores
públicos, feitos para rodar no navegador).

## Licenciamento do APISS (ativação por computador + página de administração)

O APISS pede, na primeira vez que abre num computador, um cadastro com nome
completo e e-mail funcional. Esse cadastro vira uma linha numa planilha do
Google Sheets (o relay não tem banco de dados próprio — ver aviso do plano
gratuito abaixo) e gera uma licença assinada digitalmente, amarrada àquele
computador especificamente. A administradora consegue ver quem está
cadastrado e revogar o acesso de qualquer pessoa a qualquer momento numa
página própria, protegida por senha.

### Configuração (uma vez só)

1. **Planilha do Google**: crie uma planilha com o cabeçalho
   `Nome | Email | MachineId | DataCadastro | Status` na primeira linha da
   aba "Página1". Copie o ID da planilha (o trecho da URL entre
   `/d/` e `/edit`) — é o valor de `LICENSE_SHEET_ID`.
2. **Conta de serviço do Google** (para o relay ler/escrever na planilha sem
   depender do login de ninguém): no Google Cloud Console do mesmo projeto
   já usado pelo APISS, ative a **Google Sheets API**, crie uma **conta de
   serviço**, gere uma **chave JSON** para ela, e **compartilhe a planilha**
   com o e-mail dessa conta de serviço (permissão de Editor). Do JSON
   baixado, `client_email` vira `GOOGLE_SERVICE_ACCOUNT_EMAIL` e
   `private_key` vira `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (em base64 —
   veja abaixo).
3. **Par de chaves da licença** (assinatura das licenças — não confundir com
   a conta de serviço do Google): gere localmente com
   ```
   node -e "const c=require('crypto');const{privateKey,publicKey}=c.generateKeyPairSync('ed25519');console.log('PRIVATE='+Buffer.from(privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'));console.log('PUBLIC='+Buffer.from(publicKey.export({type:'spki',format:'pem'})).toString('base64'));"
   ```
   O `PRIVATE` vira `LICENSE_PRIVATE_KEY` (só no Render, nunca no APISS). O
   `PUBLIC` é embutido no código-fonte do APISS (`license-manager.js`) para
   validar a licença offline.
4. Defina `ADMIN_SECRET` com uma senha só sua, para acessar
   `https://SEU-RELAY.onrender.com/admin.html`.
5. No Render, preencha as 4 variáveis (`GOOGLE_SERVICE_ACCOUNT_EMAIL`,
   `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` em base64 da chave privada RSA da
   conta de serviço, `LICENSE_SHEET_ID`, `LICENSE_PRIVATE_KEY`) e
   `ADMIN_SECRET`. Sem elas, o relay continua funcionando normalmente para
   tudo o mais — só a ativação/administração de licenças fica indisponível.

### Usando a página de administração

Acesse `/admin.html` no domínio do relay, entre com o `ADMIN_SECRET` e veja
a lista de quem já ativou o APISS (nome, e-mail, data, status). O botão
**Revogar** marca aquele cadastro como inativo — na próxima vez que aquele
computador verificar a licença (precisa de internet nesse momento), o APISS
bloqueia o uso com um aviso claro para a pessoa. **Reativar** desfaz.

## Aviso sobre o plano gratuito

O plano gratuito do Render "dorme" o serviço depois de ~15 minutos sem uso e
demora alguns segundos para acordar na próxima visita — normal, sem
configuração extra. O APISS reconecta sozinho quando isso acontece, e como a
senha do celular nunca expira, você não precisa entrar de novo por causa
disso.
