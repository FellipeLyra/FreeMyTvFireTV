# Testar num Fire TV de verdade

Todo o projeto foi testado com Fire TVs **simulados**. Este roteiro serve para conferir num aparelho real. A primeira parte é automática e leva uns 30 segundos. A segunda depende de alguém olhando para a TV.

Se algo falhar, abra uma *issue* com o relatório da parte automática e o que você viu.

## Preparar (uma vez)

1. No Fire TV: **Configurações → Minha Fire TV → Opções do desenvolvedor → Depuração ADB: ligada**. Se as opções do desenvolvedor não aparecerem, vá em **Minha Fire TV → Sobre** e clique 7 vezes no nome do aparelho.
2. Veja o IP da TV em **Configurações → Minha Fire TV → Sobre → Rede**. Ela e o PC precisam estar na **mesma rede**.
3. Ligue o PC à TV. Na primeira vez, a TV pergunta se confia neste PC: marque **Sempre permitir** e confirme.
   - **Studio instalado:** **Dispositivo** → digite o IP → **Conectar**.
   - **Linha de comando:** `node tools/fmtv.mjs status --device 192.168.x.x` (qualquer comando com `--device IP` conecta).

## 1. Teste automático

- **No Studio:** **Dispositivo** → no cartão da TV, **Testar aparelho**. No fim aparece uma tabela e o botão **Copiar relatório**.
- **Na linha de comando:**
  ```
  node tools/fmtv.mjs check --device 192.168.x.x --apk app/build/outputs/apk/release/app-release.apk --report teste.md
  ```
  O `--apk` é opcional: ele instala ou atualiza o app antes do teste. Já o `--no-publish` pula a publicação de teste. O Studio instalado traz o mesmo comando como `fmtv.exe`, na pasta `bin` da instalação.

O que é medido, sem root e sem mudar nenhuma configuração da TV:

| Item | Como | Bom | Aviso |
|---|---|---|---|
| Aparelho | modelo, Fire OS, RAM (`/proc/meminfo`) | | |
| Modo leve | aparelhos com menos de 1,3 GB ligam o modo leve sozinhos | | |
| Free My TV instalado | versão do app | | |
| Botão Home | o serviço de acessibilidade está ligado? | ligado | desligado |
| Tempo para abrir | `am start -W` com o app fechado | até 2,5 s | até 5 s |
| Fluidez da navegação | 12 setas do controle (`input keyevent`) e `dumpsys gfxinfo` | até 10% de quadros atrasados | até 25% |
| Memória usada | `dumpsys meminfo` (PSS do app) | até 200 MB | até 320 MB |
| Publicar um layout | publica o exemplo Clássico e espera a TV confirmar | até 8 s | até 20 s |
| TV como estava | volta ao layout que já estava, ou à tela original | | |

Durante o teste, a TV abre o Free My TV e o foco anda sozinho. Não mexa no controle até ele terminar.

Os números são um retrato, não um benchmark. A primeira abertura depois de ligar a TV é mais lenta, e a memória do WebView pode ficar em outro processo, que o `dumpsys meminfo` do app não soma.

## 2. Roteiro manual

Marque o que funcionou. As fases entre parênteses dizem de onde vem cada parte.

**Tela inicial (Fase 0)**
- [ ] A tela abre com os apps instalados, o relógio e o clima.
- [ ] As setas andam por tudo e o foco aparece sempre. OK abre o app.
- [ ] O botão **Home** do controle volta para o Free My TV (com o serviço de acessibilidade ligado).
- [ ] **≡** abre o Personalizar e **Voltar** fecha.
- [ ] Em **Personalizar → Modo de desempenho**, o "Automático" está escolhido. Em aparelho de 1 GB, o título mostra ⚡.

**Layouts (Fase 2)**
- [ ] Publicar `examples/layouts/cinema.json`: aparece a imagem de fundo e o Studio ou a CLI mostram "confirmado".
- [ ] Publicar outro layout e usar **Voltar ao anterior**: o Cinema volta.
- [ ] **≡ → Layout padrão** volta para a tela original.
- [ ] Desligar e ligar a TV: o layout continua.

**Blocos e telas (Fases 4 e 5)**
- [ ] `examples/layouts/streaming.json`: o banner e os carrosséis carregam, e as setas andam pelos cartões.
- [ ] `examples/layouts/all-screens.json`: o clima, o Personalizar, o protetor de tela e as mensagens ficam como no Studio.

**Studio (Fases 6 e 7)**
- [ ] O mapa de foco do Studio bate com o que as setas fazem na TV.
- [ ] **Publicar**, **Voltar ao anterior**, **Tela original** e **Histórico da TV** funcionam pelo Studio.

**Pela internet (Fase 8, precisa de um servidor com https)**
- [ ] Personalizar → **Publicar pela internet** → **Parear**: aparece o código.
- [ ] O Studio pareia com o código e publica. A TV troca o layout em poucos segundos.
- [ ] Com a TV em outro app, publicar e voltar para o Free My TV: o layout chega.

**Desempenho (Fase 9)**
- [ ] Num Fire TV de 1 GB, as setas não engasgam com um layout de fundo em foto.
- [ ] No Studio, uma foto grande mostra o alerta de desempenho, e **Otimizar imagens** resolve.
