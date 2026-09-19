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

## Aviso sobre o plano gratuito

O plano gratuito do Render "dorme" o serviço depois de ~15 minutos sem uso e
demora alguns segundos para acordar na próxima visita — normal, sem
configuração extra. O APISS reconecta sozinho quando isso acontece, e como a
senha do celular nunca expira, você não precisa entrar de novo por causa
disso.
