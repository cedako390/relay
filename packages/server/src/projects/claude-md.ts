import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MCP_SERVER_NAME } from '../sessions/claude-config.js';

export const SECTION_BEGIN = '<!-- orchestrator:begin (managed automatically, do not edit) -->';
export const SECTION_END = '<!-- orchestrator:end -->';

const tool = (name: string): string => `mcp__${MCP_SERVER_NAME}__${name}`;

/** Rules for agents working in a project that is driven by the Orchestrator. */
export const ORCHESTRATOR_SECTION_BODY = `## Работа под Orchestrator

Ты запущен внутри Orchestrator: локальной панели, которая управляет несколькими сессиями Claude Code. Бэкенд
панели единственный источник правды о сессиях и задачах. Эти правила действуют в любой сессии проекта.

### Субагенты: только через бэкенд
- Встроенные инструменты \`Agent\` / \`Task\` (нативные субагенты Claude Code) здесь **отключены**. Не пытайся их
  вызвать и не имитируй субагента внутри собственного контекста.
- Чтобы поручить работу другому агенту, создай задачу инструментом \`${tool('create_task')}\`. Бэкенд сам запустит
  отдельную сессию-воркера (свой процесс \`claude\`, свой терминал), и она видна пользователю в панели.
- Делегируй, когда работа независима, объёмна или может идти параллельно. Мелочь (прочитать файл, сделать
  одну правку) делай сам: воркер стоит времени и лимитов подписки.

### MCP-сервер \`${MCP_SERVER_NAME}\`
Сервер подключён к сессии автоматически (Streamable HTTP на локальном бэкенде). Схемы его инструментов подгружаются
лениво: если инструмента нет в списке, сначала загрузи его схему через ToolSearch (\`select:${tool('create_task')}\`).
Кто ты, бэкенд определяет по сессии, а не по аргументам вызова: свой id указывать не нужно, подделать чужую личность нельзя.

| Инструмент | Что делает |
|---|---|
| \`${tool('create_task')}\` | \`title\`, \`description\`, необязательно \`model\` (\`haiku\`, \`sonnet\`, \`opus\`; без него модель по умолчанию) и \`parent_id\` (по умолчанию твоя собственная задача). Создаёт задачу и сразу запускает воркера. Возвращает задачу (\`id\`, \`status\`, …) без ожидания результата |
| \`${tool('get_task')}\` | \`id\`. Статус задачи (\`pending\`, \`queued\`, \`running\`, \`done\`, \`failed\`, \`cancelled\`) и результат |
| \`${tool('list_children')}\` | \`parent_id\`. Прямые подзадачи со статусами и результатами |
| \`${tool('report_result')}\` | \`task_id\`, \`status\` (\`done\` или \`failed\`), \`result\`. Итог своей задачи; вызывается ровно один раз |
| \`${tool('send_message')}\` | \`session_id\`, \`body\`. Ставит сообщение в очередь другой активной сессии; оно печатается в неё, когда сессия освободится. Ответа не возвращает |
| \`${tool('create_orchestrator')}\` | \`title\`, \`instructions\`, необязательно \`cwd\` (по умолчанию твоя папка) и \`model\`. Запускает ещё одного оркестратора на свою часть работы. Возвращает \`session_id\`. Только для оркестраторов, воркерам недоступен |
| \`${tool('close_session')}\` | \`session_id\`. Закрывает оркестратор, который создал ты. Его воркеры доработают сами |

### Как ставить задачу воркеру
- Воркер **ничего не знает** о твоём диалоге: он видит только \`description\`. Опиши цель, нужные файлы и пути,
  ограничения, критерии готовности и что именно вернуть в результате. Ссылки вроде «как мы обсуждали» не работают.
- Независимые задачи создавай сразу пачкой: они пойдут параллельно.
- Воркеров одновременно ограниченное число (лимит настраивается). Лишние задачи получают статус \`queued\` и стартуют
  сами, когда освободится слот. Это нормально, повторно создавать их не нужно.
- Глубина вложенности задач тоже ограничена: при превышении \`create_task\` вернёт ошибку. Не делегируй дальше без нужды.
- Если проект лежит в git-репозитории с коммитами, воркер работает в **отдельном git worktree** на ветке \`orch/<id задачи>\`:
  его правки не попадают в твою рабочую папку сами. Воркеру стоит указать в результате ветку (\`git branch --show-current\`), а слияние делаешь ты (или пользователь).
  Вне git (или без коммитов) воркер работает прямо в папке проекта: не отдавай параллельным воркерам задачи, которые
  правят одни и те же файлы.

### Получение результата
- Когда задача завершилась (\`done\`, \`failed\` или \`cancelled\`), ты **автоматически** получишь сообщение
  \`[Orchestrator] Task "…" (id …) finished with status: …\` с результатом. Оно приходит как обычный ввод, когда ты свободен.
- **Не опрашивай** статус в цикле и не жди внутри хода. Создал задачи: займись другой работой или закончи ход и
  дождись сообщений. \`get_task\` / \`list_children\` нужны для разового уточнения, а не для поллинга.
- Результат воркера это краткая сводка, а не истина: проверь важное (diff, тесты), прежде чем считать работу сделанной.

### Крупная работа: несколько оркестраторов
Если задача делится на независимые части (например, TODO.md с работой для фронта и для бэка), каждую часть можно отдать
отдельному оркестратору через \`${tool('create_orchestrator')}\`. Он сам раздаёт своей части воркеров, а ты занимаешься своей.
- Создавай оркестратор, только когда части объёмные и независимые. Для мелочи хватит \`create_task\`.
- В \`instructions\` опиши его часть, чужие части (чтобы не лез), пути, ограничения и что вернуть. Твоего диалога он не видит.
- Когда он закончит, ты **автоматически** получишь его отчёт сообщением. Не опрашивай. Если он завершился сам, придёт уведомление.
- Прочитав отчёт, закрой оркестратор через \`${tool('close_session')}\`: открытая сессия занимает слот и ресурсы.
- Лимиты: число активных вложенных оркестраторов и глубина вложенности ограничены (инструмент вернёт ошибку). Воркеры всех
  оркестраторов делят общий лимит. Параллельные оркестраторы в одной папке без git worktree не должны править одни и те же файлы.

### Если ты воркер
Первое сообщение в твоей сессии начинается с «You are a worker agent started by the Orchestrator» и содержит id задачи.
- Выполни задачу из описания и не расширяй её.
- В конце вызови \`${tool('report_result')}\` один раз: \`status\` \`done\` при успехе или \`failed\` с причиной, \`result\` краткая
  сводка (что сделано, где лежит, ветка, что не удалось). Повторный вызов вернёт ошибку.
- После \`report_result\` ничего больше не делай: сессия закроется сама, как только освободится.
- Уточнить что-то у создателя задачи нельзя: ты не знаешь его сессию, а ответ не придёт. Прими разумные допущения и
  перечисли их в \`result\`; если без ответа работать невозможно, заверши отчётом \`failed\` с описанием, чего не хватило.
- Создавать оркестраторы воркер не может.
- Свою задачу можно дробить на подзадачи тем же \`${tool('create_task')}\` (родитель подставится сам), но помни про лимиты.`;

export const ORCHESTRATOR_SECTION = `${SECTION_BEGIN}\n${ORCHESTRATOR_SECTION_BODY}\n${SECTION_END}`;

export type ClaudeMdAction = 'created' | 'updated' | 'unchanged';

/**
 * Returns `existing` with the managed Orchestrator section inserted or replaced. Text outside the
 * markers is never touched; a new section is appended after a blank line. Line endings of the
 * existing file (CRLF or LF) are kept.
 */
export function applyOrchestratorSection(existing: string): string {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const section = ORCHESTRATOR_SECTION.replace(/\n/g, eol);

  const begin = existing.indexOf(SECTION_BEGIN);
  const end = begin === -1 ? -1 : existing.indexOf(SECTION_END, begin);
  if (begin !== -1 && end !== -1) {
    return existing.slice(0, begin) + section + existing.slice(end + SECTION_END.length);
  }
  if (existing.trim() === '') return section + eol;
  return existing.replace(/\s*$/, '') + eol + eol + section + eol;
}

/**
 * Makes sure `<projectDir>/CLAUDE.md` contains the up-to-date Orchestrator rules: creates the file
 * when it does not exist, otherwise adds or refreshes only the managed section. Safe to call repeatedly.
 */
export function ensureOrchestratorClaudeMd(projectDir: string): ClaudeMdAction {
  const file = path.join(projectDir, 'CLAUDE.md');
  if (!existsSync(file)) {
    writeFileSync(file, applyOrchestratorSection(''), 'utf8');
    return 'created';
  }
  const current = readFileSync(file, 'utf8');
  const next = applyOrchestratorSection(current);
  if (next === current) return 'unchanged';
  writeFileSync(file, next, 'utf8');
  return 'updated';
}
