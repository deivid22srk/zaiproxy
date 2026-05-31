# ZAI Proxy

Proxy local OpenAI-compatible para usar uma sessao real do `chat.z.ai` com clientes como Zed, OpenAI SDK/Codex e ferramentas que falam `/v1/chat/completions` ou `/v1/responses`.

## Fluxo

```bash
npm install
npm run login
npm run build
npm start
```

O login abre Chromium visivel porque depende de OAuth. Se o perfil `default` estiver preso em conta guest, invalida ou em cooldown, `npm run login` abre um perfil novo automaticamente para voce adicionar outra conta.

```bash
npm run login -- --fresh
npm run login -- --account backup-1
npm run login -- --reuse-profile
npm run accounts
```

Captcha de uso roda em Chromium headless persistente, com pagina real carregada em segundo plano e cache por conta.

```bash
CAPTCHA_HEADLESS=false npm start
CAPTCHA_KEEP_BROWSER_OPEN=false npm start
```

## Rotas

- `GET /health`
- `GET /v1/health`
- `GET /v1/models`
- `GET /v1/models?verbose=true`
- `GET /v1/models/:id`
- `POST /v1/chat/completions`
- `GET /v1/chat/completions/:id`
- `DELETE /v1/chat/completions/:id`
- `POST /v1/responses`
- `GET /v1/responses/:id`
- `DELETE /v1/responses/:id`
- `GET /v1/proxy/tools`

O proxy normaliza barras duplicadas, entao `/v1//chat/completions` cai na rota canonica. Por padrao, `/v1/models` retorna o formato OpenAI estrito; use `verbose=true` para ver metadados extras.

## Compatibilidade

O formato padrao evita campos extras que quebram parsers estritos do Zed. `reasoning_content` nao e enviado por padrao; ative apenas se o cliente suportar:

```json
{
  "zai": { "include_reasoning": true }
}
```

Cooldowns de conta sao curtos: erros de limite, captcha rejeitado ou falha temporaria deixam a conta fora da rotacao por cerca de 1 minuto. Isso evita tratar uma conta instavel como morta.

`prompt_cache_key` e usado como chave real de conversa no proxy, evitando criar um chat novo no Z.ai a cada chamada. Sem chave explicita, Chat Completions usa uma conversa padrao por conta/modelo; Responses encadeia pelo `previous_response_id`.

`parallel_tool_calls`, `tools`, `tool_choice` e `stream_options` sao aceitos para compatibilidade com SDKs e CLIs OpenAI, mas nao sao enviados crus para a API interna da Z.ai. O payload upstream fica no formato observado no navegador da Z.ai para evitar `INTERNAL_ERROR`.

## Tool calls

As tools nativas da Z.ai ficam desligadas no payload interno: o proxy nao envia `tool_selector_h`, `mcp_servers` ou definicoes OpenAI diretamente para o upstream.

Quando um cliente como Zed ou OpenCode envia `tools`, o proxy injeta um contrato de tool-call no prompt da Z.ai, valida o JSON gerado e devolve `tool_calls` no formato Chat Completions:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_...",
            "type": "function",
            "function": {
              "name": "write_file",
              "arguments": "{\"path\":\"index.html\",\"content\":\"...\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

O parser aceita somente JSON valido, nomes conhecidos e argumentos compatíveis com o schema da tool. Se o modelo gerar formato invalido, o console registra `TOOLS Invalid tool-call format` com erros de schema e preview bruto da resposta, e o proxy tenta uma correcao curta antes de falhar.

Se o cliente nao enviar tools, o proxy tambem tem tools locais restritas (`list_directory`, `read_file`, `create_directory`, `write_file`, `edit_file`, `apply_patch`, `grep`, `move_path`). Elas so entram automaticamente se `PROXY_NATIVE_TOOLS_AUTO=true`, ou por request com:

```json
{
  "zai": { "proxy_tools": true }
}
```

As tools locais nunca podem sair de `PROXY_TOOLS_ROOT`, bloqueiam arquivos sensiveis como `.env`, `master.key`, SQLite e chaves privadas, e `edit_file`/`apply_patch` falham se o bloco de busca nao bater exatamente.

## Zed

Exemplo em `~/.config/zed/settings.json`:

```json
{
  "language_models": {
    "openai_compatible": {
      "Farofinha": {
        "api_url": "http://127.0.0.1:3000/v1",
        "available_models": [
          {
            "name": "GLM-5.1",
            "display_name": "GLM 5.1",
            "max_tokens": 200000,
            "max_output_tokens": 32000,
            "max_completion_tokens": 32000,
            "capabilities": {
              "tools": true,
              "images": false,
              "parallel_tool_calls": true,
              "prompt_cache_key": true,
              "chat_completions": true,
              "interleaved_reasoning": false
            }
          }
        ]
      }
    }
  },
  "agent": {
    "default_model": {
      "provider": "openai_compatible",
      "model": "GLM-5.1"
    }
  }
}
```

Se voce definir `PROXY_API_KEY`, use o mesmo valor como chave no cliente. Sem `PROXY_API_KEY`, o proxy aceita qualquer bearer local.

## OpenAI SDK / Codex

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.FAROFINHA_API_KEY ?? "local",
  baseURL: "http://127.0.0.1:3000/v1"
});

const chat = await client.chat.completions.create({
  model: "GLM-5.1",
  prompt_cache_key: "zed-workspace-main",
  parallel_tool_calls: true,
  messages: [{ role: "user", content: "Responda apenas: ok" }]
});

const response = await client.responses.create({
  model: "GLM-5.1",
  input: "Responda apenas: ok",
  prompt_cache_key: "codex-session-main",
  parallel_tool_calls: true
});
```

Modelos com prefixo de provider tambem funcionam no request, por exemplo `z.ai/GLM-5.1`; o proxy remove o prefixo antes de chamar o Z.ai e mantem o formato OpenAI na resposta.

## OpenCode

Arquivo usado localmente:

```text
/home/elaine/.config/opencode/opencode.jsonc
```

Config minima esperada:

```jsonc
{
  "model": "z.ai/GLM-5.1",
  "small_model": "z.ai/GLM-5-Turbo",
  "provider": {
    "z.ai": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Farofinha Z.ai Proxy",
      "options": {
        "baseURL": "http://127.0.0.1:3000/v1",
        "apiKey": "local"
      },
      "models": {
        "GLM-5.1": { "name": "GLM-5.1" },
        "GLM-5-Turbo": { "name": "GLM-5-Turbo" }
      }
    }
  }
}
```

## OpenRouter-style

Qualquer cliente que permita endpoint OpenAI-compatible deve usar:

```text
base_url: http://127.0.0.1:3000/v1
model: GLM-5.1
api_key: local
```

## Variaveis

```env
HOST=127.0.0.1
PORT=3000
PROXY_API_KEY=

ZAI_BASE_URL=https://chat.z.ai
ZAI_DEFAULT_MODEL=GLM-5.1

CAPTCHA_HEADLESS=true
CAPTCHA_KEEP_BROWSER_OPEN=true
CAPTCHA_TIMEOUT_MS=180000

PROXY_NATIVE_TOOLS=true
PROXY_NATIVE_TOOLS_AUTO=false
PROXY_TOOLS_ROOT=.
PROXY_TOOLS_MAX_FILE_BYTES=1048576
PROXY_TOOLS_MAX_WRITE_BYTES=1048576
PROXY_TOOLS_MAX_ROUNDS=6
```

# Disclaimer

Este projeto foi criado **unicamente para fins de estudo, pesquisa, aprendizado e uso interno**.

A **Z.AI Proxy** não é afiliada, associada, autorizada, endossada ou mantida pela Z.AI, Zhipu AI ou qualquer empresa relacionada.

O objetivo deste repositório é estudar conceitos técnicos como:

- proxies compatíveis com APIs;
- transformação de payloads;
- streaming;
- autenticação;
- integração entre ferramentas;
- arquitetura de servidores em TypeScript.

## Aviso de responsabilidade

Este projeto **não tem como objetivo incentivar, orientar ou facilitar abuso de serviços, violação de termos de uso, burlar limites, explorar falhas, revender acesso não autorizado ou prejudicar qualquer plataforma**.

Não compactuo com o uso deste código para atividades indevidas, ilegais, abusivas ou contrárias aos termos de serviço de qualquer provedor.

Qualquer pessoa que utilize este projeto é totalmente responsável pelo próprio uso, incluindo o cumprimento das leis aplicáveis, políticas de uso, termos de serviço e regras das plataformas envolvidas.

## Uso recomendado

Este projeto deve ser utilizado apenas em ambientes controlados, locais, privados ou educacionais, com contas, credenciais e permissões próprias.

Caso você represente alguma empresa, plataforma ou detentor de direitos e tenha qualquer preocupação sobre este repositório, entre em contato para que eu possa analisar e tomar as providências necessárias.

## Sem garantias

Este software é fornecido “como está”, sem garantias de funcionamento, segurança, compatibilidade ou adequação para qualquer finalidade específica.

O autor não se responsabiliza por danos, bloqueios, perdas, mau uso ou consequências decorrentes da utilização deste projeto.
