# 💰 SalvaMoney Bot — WhatsApp

Bot que registra gastos via WhatsApp e salva direto no Firebase.

## 🚀 Deploy no Railway (grátis)

### 1. Crie conta no Railway
Acesse: https://railway.app e entre com GitHub.

### 2. Suba os arquivos
- Crie um repositório no GitHub com esses arquivos
- No Railway: New Project → Deploy from GitHub Repo

### 3. Configure as variáveis de ambiente
No Railway, vá em **Variables** e adicione cada linha do `.env`.

### 4. Pegue a URL do servidor
O Railway vai gerar uma URL tipo:
`https://salvamoney-bot-production.up.railway.app`

### 5. Configure o Webhook no Z-API
No painel do Z-API:
- Vá em **Webhooks**
- Cole a URL: `https://SUA-URL.railway.app/webhook`
- Ative os eventos: **ReceivedCallback**

---

## 💬 Comandos do Bot

| Mensagem | O que faz |
|---|---|
| `entrar João CASA2024` | Vincula o número ao usuário/grupo |
| `gastei 50 almoço` | Registra R$50 em Alimentação |
| `35 uber` | Registra R$35 em Transporte |
| `mercado 120,50` | Registra R$120,50 em Alimentação |
| `resumo` | Mostra total do mês por categoria |
| `ajuda` | Mostra todos os comandos |

---

## 📂 Estrutura Firebase criada pelo bot

```
bot_sessions/
  {phone}/
    user: "João"
    group: "CASA2024"

grupos/{group}/usuarios/{user}/gastos/{ano_mes}/
  {id}/
    desc: "almoço"
    value: 50
    cat: "Alimentação"
    date: "2026-05-14"
    user: "João"
    viaBot: true
```
