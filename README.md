![Como não compartilhar tela no Discord](como-nao-compartilhar-tela-no-discord-banner.png)

# Sala de Tela

Mostre sua tela para quem está na mesma call do Discord.
Uma pessoa compartilha, todo mundo assiste sem sair do Discord.

Também funciona como site normal, fora do Discord, com salas que você cria e
compartilha por link.

---

## O que você precisa antes

**1. Node.js** — é o programa que faz tudo isso rodar.

Baixe em [nodejs.org](https://nodejs.org), escolha a versão **LTS** e instale
clicando em avançar até o fim. Não precisa configurar nada.

**2. Google Chrome, Edge, Brave ou Opera** — só para quem vai *mostrar* a tela.
Para *assistir*, qualquer navegador serve.

> Não funciona no celular para compartilhar. Celular não deixa nenhum site
> capturar a tela. Assistir pelo celular também costuma falhar.

---

## Testar agora (2 minutos)

Serve para ver funcionando antes de mexer com o Discord.

**1.** Baixe este projeto e descompacte numa pasta.

**2.** Abra a pasta, clique na barra de endereço do explorador de arquivos,
digite `cmd` e aperte Enter. Vai abrir uma janela preta — é ali que você digita
os comandos.

**3.** Digite, um de cada vez, esperando cada um terminar:

```
npm install
npm run configurar
```

Quando ele perguntar como você quer usar, escolha **1**.

**4.** Agora ligue o programa:

```
npm start
```

**5.** Abra <http://localhost:3001> no navegador.

Abra o mesmo endereço numa **segunda janela**. Crie uma sala numa, entre nela
pela outra, e clique em **Compartilhar tela**. Você vai ver sua própria tela
chegando do outro lado.

Para desligar, volte na janela preta e aperte `Ctrl + C`.

---

## Usar dentro do Discord

Aqui dá mais trabalho porque o Discord exige que você registre o programa no
site dele. É uma vez só. Reserve uns 10 minutos.

Dentro do Discord não existe lista de salas: quem abre a atividade cai direto
na sala daquela call, junto com o resto do pessoal que está lá.

### Passo 1 — Ligue o endereço público

O Discord precisa de um endereço na internet para alcançar o programa que roda
no seu computador. Isso se resolve sozinho:

```
npm run tunel
```

**Deixe essa janela aberta.** Ela vai mostrar um endereço parecido com
`https://algo-aleatorio.trycloudflare.com`. Não precisa copiar — o programa já
guarda sozinho.

### Passo 2 — Configure

Abra uma **segunda** janela preta na mesma pasta e rode:

```
npm run configurar
```

Escolha a opção **2** e siga o que aparecer na tela. Ele vai pedir dois valores
do site do Discord e dizer exatamente onde encontrar cada um.

No fim, ele mostra **três coisas para colar no site do Discord**, já preenchidas
com os seus dados. Faça as três.

### Passo 3 — Ligue

```
npm start
```

### Passo 4 — Abra no Discord

Entre num canal de voz do seu servidor, clique no **foguete** 🚀 na barra de
baixo e escolha a atividade.

---

## Deu errado?

**"Não foi possível entrar" ou a tela fica preta no Discord**
O endereço do túnel muda toda vez que você fecha e abre o `npm run tunel`.
Quando isso acontece, vá no site do Discord em **Activities → URL Mappings** e
troque o *Target* pelo endereço novo (a janela do túnel mostra qual é).

**O botão de compartilhar abre uma aba e não acontece nada**
Essa aba precisa continuar aberta enquanto você transmite. Pode voltar para o
Discord normalmente, só não feche a aba.

**"npm não é reconhecido como um comando"**
O Node.js não foi instalado, ou a janela preta foi aberta antes da instalação.
Feche a janela, abra de novo e tente outra vez.

**Quero mudar alguma configuração**
Rode `npm run configurar` de novo. Ele lembra do que você já respondeu — é só
apertar Enter no que não mudou.

**A "Sala da call" não confere quem está no canal de voz**
Isso é opcional e só importa se você quer garantir que apenas quem está na call
consiga entrar. Precisa criar um bot no site do Discord e colar o token dele em
`DISCORD_BOT_TOKEN`, dentro do arquivo `.env`. Sem isso tudo funciona igual.

---

## Deixar no ar direto (sem seu computador ligado)

Você precisa de uma hospedagem que rode Node.js. Lá dentro:

1. Coloque o projeto e rode `npm install`.
2. Crie o arquivo `.env` com `npm run configurar`.
3. Troque, dentro do `.env`:
   - `NODE_ENV` para `production`
   - `PUBLIC_ORIGIN` para o endereço do seu site (ex: `https://tela.seusite.com`)
4. Rode `npm start`.

No site do Discord, troque o *Target* e o *Redirect* pelo endereço do seu site.
Aí o `npm run tunel` deixa de ser necessário.

---

## Comandos, resumidos

| Comando | Para quê |
|---|---|
| `npm install` | Baixa o que o programa precisa. Só na primeira vez. |
| `npm run configurar` | Faz as perguntas e monta a configuração. |
| `npm run tunel` | Cria o endereço público para o Discord alcançar você. |
| `npm start` | Liga o programa. |
| `npm run smoke` | Confere se está tudo funcionando por dentro. |

---

## Compartilhando com som

Ao clicar em **Compartilhar tela**, marque *Compartilhar o som do computador*.

Depois, na janela que o navegador abre para escolher a tela, marque também a
caixinha de **áudio** que aparece lá embaixo. São duas marcações: a primeira diz
que você quer som, a segunda é o navegador pedindo permissão. Sem a segunda, ele
entrega a tela em silêncio.

Quem assiste tem um botão de alto-falante na barra de baixo para silenciar.

> Som funciona no Chrome, Edge, Brave e Opera. No Windows dá para pegar o som do
> computador inteiro; no Mac, só o som de uma aba do navegador — é limitação do
> sistema, não do programa.

---

## O que ainda não dá

- **Compartilhar do celular.** Nenhum navegador de celular permite.
- **Muita gente ao mesmo tempo.** Cada pessoa assistindo consome uns 2 Mb/s da
  sua internet. Cinco pessoas já são 10 Mb/s.
- **Mais de 4 telas ao mesmo tempo** na mesma sala.

Se você mexe em código e quer entender as decisões por trás disso,
veja [docs/como-funciona.md](docs/como-funciona.md).
