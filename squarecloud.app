# Configuração de deploy da Square Cloud.
#
# É este arquivo que responde ao "defina um arquivo principal válido" do
# painel: sem ele a plataforma não tem como saber o que executar num
# repositório com três package.json (raiz, client e server).
#
# O site precisa escutar na porta 80 — exigência da Square Cloud, não do
# programa. Ela chega pela variável PORT, junto com o resto da configuração,
# em "Variáveis de ambiente" no painel.

DISPLAY_NAME=Sala de Tela
DESCRIPTION=Compartilhamento de tela com som para o Discord

# O caminho é a partir da raiz do que sobe: o servidor mora em server/.
MAIN=server/index.js

# O build do site NÃO entra aqui de propósito. O vite é devDependency, e a
# Square Cloud não instala devDependencies — "npm run build" lá dentro falharia
# com "vite: not found". O client/dist sobe pronto, montado aqui.
START=node server/index.js

MEMORY=512
VERSION=recommended
SUBDOMAIN=tela-discord
AUTORESTART=true
