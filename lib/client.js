window.__ModuleLoader__.load({
	id: "dsh-balance-hud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/**
		 * 版本标记：显示在 tooltip 里，用来一眼确认浏览器加载的是哪一版 bundle。
		 * 客户端 bundle 的更新依赖页面重新拉取，遇到「改了没反应」时先看这个。
		 */


		//#region 价格表（元 / 百万 tokens，官方 https://api-docs.deepseek.com/zh-cn/quick_start/pricing）
		/**
		 * 每个模型两档价：峰时价与闲时价。官方规则是「闲时 = 峰时的一半」，
		 * 峰时 = 北京时间周一至周五 9:00–12:00、14:00–18:00，其余时段（含周末
		 * 与法定节假日）全部按闲时计。
		 */
		const PRICES = {
			"deepseek-flash": {
				label: "DeepSeek-V4.1-Flash",
				cacheHit: { peak: 0.04, off: 0.02 },
				cacheMiss: { peak: 2, off: 1 },
				output: { peak: 8, off: 4 }
			},
			"deepseek-v4-pro": {
				label: "DeepSeek-V4-Pro",
				cacheHit: { peak: 0.3, off: 0.15 },
				cacheMiss: { peak: 9, off: 4.5 },
				output: { peak: 27, off: 13.5 }
			}
		};

		/** 兜底：未知模型按 flash 价算，避免显示成 0 让人以为免费。 */
		const FALLBACK_MODEL = "deepseek-flash";

		/** 内置价格表的抓取日期：同步不可用时用它，并如实告诉用户这是哪天的价。 */
		const BUILTIN_PRICES_DATE = "2026-09-29";
		/** 官方价格页地址（价格的唯一权威来源）。 */
		const PRICING_DOC_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
		/** 同步结果缓存的 localStorage 键（含条件请求头与抓取时间）。 */
		const PRICES_CACHE_KEY = "dsh-balance-hud:prices:v1";
		/** 价格同步路由（Host 半边唯一的外联出口）。 */
		const PRICING_ROUTE = "/api/balance-hud/pricing";
		/** 模型目录路由（Host 半边读 DSH 自己的 llm 注册表，**不联网**）。 */
		const MODELS_ROUTE = "/api/balance-hud/models";
		/** 自动同步间隔选项（小时）；0 表示不自动同步。 */
		const SYNC_INTERVAL_HOURS = [0, 6, 24, 72, 168];
		/** 默认自动同步间隔（小时）：价格是"几个月一次"的事件，24 小时足够，
		 *  而且页面支持 ETag 条件请求，没变时只花一个 304 的往返。 */
		const DEFAULT_SYNC_HOURS = 24;

		/**
		 * 读价格缓存：包含解析出的价格表、条件请求头与抓取时间。
		 * @returns `{ models, capturedAt, etag, lastModified, source }` 或 null。
		 */
		function loadPriceCache() {
			try {
				const raw = globalThis.localStorage?.getItem(PRICES_CACHE_KEY);
				if (raw === null || raw === undefined) return null;
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || typeof parsed.models !== "object") return null;
				return parsed;
			} catch {
				return null;
			}
		}

		/**
		 * 写价格缓存。
		 * @param value - `{ models, capturedAt, etag, lastModified, source }`。
		 */
		function savePriceCache(value) {
			try {
				globalThis.localStorage?.setItem(PRICES_CACHE_KEY, JSON.stringify(value));
			} catch {
				// 存不下就只在本次会话生效
			}
		}

		/**
		 * 走 Host 路由同步一次官方价格。
		 *
		 * **这是插件里唯一会引发外联的调用**，且只由用户动作触发
		 * （点「同步价格」按钮，或用户主动选了自动同步间隔后的定时器）。
		 *
		 * 会带上上次的 `ETag` / `Last-Modified` 做条件请求：
		 * 页面没改时服务端返回 304（只有响应头、没有正文）。
		 *
		 * @returns `{ kind, ... }`：`notModified` / `ok`（附 models）/ `error`。
		 */
		async function syncPrices() {
			const cached = loadPriceCache();
			const query = new URLSearchParams();
			if (typeof cached?.etag === "string") query.set("etag", cached.etag);
			if (typeof cached?.lastModified === "string") query.set("lastModified", cached.lastModified);
			const suffix = query.toString() === "" ? "" : `?${query.toString()}`;

			let response;
			try {
				response = await fetch(`${PRICING_ROUTE}${suffix}`, {
					method: "GET",
					headers: { accept: "application/json" },
					cache: "no-store"
				});
			} catch (error) {
				return { kind: "error", reason: `同步路由不可达：${error && error.message ? error.message : String(error)}` };
			}
			if (!response.ok) return { kind: "error", reason: `同步路由返回 HTTP ${response.status}` };

			let payload;
			try {
				payload = await response.json();
			} catch {
				return { kind: "error", reason: "同步路由返回了非 JSON 内容" };
			}
			if (payload?.kind === "notModified") {
				// 内容未变：刷新一下抓取时间，保留原有价格表
				if (cached !== null) {
					savePriceCache({ ...cached, capturedAt: cached.capturedAt, checkedAt: new Date().toISOString() });
				}
				return { kind: "notModified" };
			}
			if (payload?.kind !== "ok" || typeof payload.html !== "string") {
				return { kind: "error", reason: payload?.reason ?? "同步路由返回了未知形状" };
			}

			// 解析交给纯函数；解析失败**整条放弃**，保留上一份可用价格
			const parsed = parsePricingPage(payload.html);
			if (parsed === null) {
				return { kind: "error", reason: "价格页结构无法识别（已保留原有价格）" };
			}
			const next = {
				models: parsed.models,
				capturedAt: parsed.capturedAt,
				checkedAt: parsed.capturedAt,
				etag: typeof payload.etag === "string" ? payload.etag : null,
				lastModified: typeof payload.lastModified === "string" ? payload.lastModified : null,
				source: "synced"
			};
			savePriceCache(next);
			return { kind: "ok", models: parsed.models, capturedAt: parsed.capturedAt };
		}

		/**
		 * 读 DSH 注册的模型目录（走 Host 路由，**不联网**）。
		 * @returns `{ providers, models }`；失败返回空目录。
		 */
		async function readModels() {
			try {
				const response = await fetch(MODELS_ROUTE, {
					method: "GET",
					headers: { accept: "application/json" },
					cache: "no-store"
				});
				if (!response.ok) return { providers: [], models: {} };
				const payload = await response.json();
				if (payload?.kind !== "ready") return { providers: [], models: {} };
				return { providers: payload.providers ?? [], models: payload.models ?? {} };
			} catch {
				return { providers: [], models: {} };
			}
		}

		/**
		 * 从官方价格页的 HTML 里解析出价格表。
		 *
		 * 这是整条链路里**最脆的一环** —— 文档改版就会失效。所以做成纯函数，
		 * 好拿真实抓取的页面写测试。
		 *
		 * 页面表格结构（2026-09 快照）：
		 *
		 * ```html
		 * <tr><td colspan="3">模型</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
		 * ...
		 * <tr><td rowspan="6">价格</td>            <!-- 左列 = 说明 -->
		 *     <td rowspan="2">…缓存命中）</td>
		 *     <td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
		 * <tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
		 * ...（未命中输入、输出各两行）
		 * ```
		 *
		 * **刻意不把标签文字当唯一判据** —— 文案最容易改。稳定锚点是：
		 * 每个价格单元格都以 `元` 结尾，模型名是已知的英文 id。于是：
		 * - 表头行：含两个 `deepseek-*` → 得到模型列顺序；
		 * - 价格行：恰有「模型数」个 `元` 结尾的单元格 → 就是各模型的价格；
		 * - 档位：优先认「高峰」标记，认不出就退回**按出现顺序**
		 *   （每类第一行空闲、第二行高峰，这是官方表格的固定排版）。
		 *
		 * 全部数值必须过校验（有限、非负、两档齐全），否则**整条放弃**、
		 * 调用方回落内置表 —— 宁可用旧价，也不能用半解析出来的错价。
		 *
		 * @param text - 页面 HTML 文本。
		 * @returns `{ models, capturedAt }`；解析失败返回 null。
		 */
		function parsePricingPage(text) {
			if (typeof text !== "string" || text.length === 0) return null;
			// 脚本 / 样式 / 注释里也有数字，先去掉，避免误判
			const cleaned = text
				.replace(/<script[\s\S]*?<\/script>/gi, " ")
				.replace(/<style[\s\S]*?<\/style>/gi, " ")
				.replace(/<!--[\s\S]*?-->/g, " ");
			const rows = cleaned.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
			if (rows.length === 0) return null;

			/** 一行 → 单元格文本（剥标签、解实体、压空白）。 */
			const cellsOf = (row) =>
				(row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map((cell) =>
					cell
						.replace(/<[^>]*>/g, " ")
						.replace(/&nbsp;/g, " ")
						.replace(/&amp;/g, "&")
						.replace(/\s+/g, " ")
						.trim()
				);

			// ① 表头：第一行含两个以上 deepseek-* 模型名
			let modelIds = null;
			for (const row of rows) {
				const ids = cellsOf(row)
					.map((cell) => cell.match(/^(deepseek-[a-z0-9.-]+)/i)?.[1]?.toLowerCase() ?? "")
					.filter((id) => id.length > 0);
				if (ids.length >= 2) {
					modelIds = ids;
					break;
				}
			}
			if (modelIds === null) return null;
			const columnCount = modelIds.length;

			/**
			 * 一行里"纯数字 + 可选币种后缀"的价格值，按出现顺序对应模型列。
			 *
			 * **不能写死"元"字，也不能限定后缀长度**：
			 * 页面可能是 UTF-8 字节被按 Latin-1 解码拿到的（不同抓取链路会这样），
			 * `元` 会变成 `å…ƒ` —— **两个**码点，长度还会随解码方式变化。
			 *
			 * 所以判据只压在**数字本身**上：单元格以数字开头，
			 * 后面除了空白与任意非数字字符以外什么都没有。
			 * 这样无论后缀是 `元`、`å…ƒ` 还是空都能命中；
			 * 含字母的说明单元格（如 `百万tokens输入`）不会误入。
			 */
			const numericOf = (row) =>
				cellsOf(row).map((cell) => {
					const match = cell.match(/^(\d+(?:\.\d+)?)\s*\D*$/);
					return match === null ? undefined : Number(match[1]);
				});

			// ② 价格行：**末尾 columnCount 格是数字，前面的格都不是数字**
			//
			// 判据来自真实页面形状：每个价格行左半边是说明
			// （`价格(2)`、`百万tokens输入（缓存命中）`、`空闲时段`／`高峰时段`），
			// 右半边正好是每模型一个价格。**格数不固定**：
			// 含「空闲时段」的行多一格、含「高峰时段」的行少一格，所以不能按格数卡。
			//
			// 这个判据还会捞进噪声行：表头的 `上下文长度 | 1M`，
			// 以及紧跟在价格区段后面的 `并发限制 | 2500 | 500`。
			// 所以**不能**按"连续 6 行"取 —— 并发限制那一行会把区段撑到 7 行。
			//
			// 改为：枚举从每个候选行起的连续 6 行组合，用语义校验挑出正确的那组。
			// 混进噪声行时数值对不上，`peak > off` 会失败，于是试下一组。
			const isPriceRow = (row) => {
				const values = numericOf(row);
				if (values.length <= columnCount) return false;
				const tail = values.slice(values.length - columnCount);
				if (tail.some((value) => value === undefined)) return false;
				return values.slice(0, values.length - columnCount).every((value) => value === undefined);
			};
			const candidates = [];
			rows.forEach((row, index) => {
				if (isPriceRow(row)) candidates.push(index);
			});

			/**
			 * 把连续 6 行归类成三类别两档价。
			 *
			 * 档位**完全按位置**判断：官方表格固定是「每类别两行，先空闲后高峰」。
			 * 为什么不用文字标记（"空闲时段"/"高峰时段"）：
			 * 页面可能是 UTF-8 字节被按 Latin-1 解码拿到的，中文字符会变成乱码，
			 * 任何中文匹配都会失效。位置规则不依赖编码，再由 `peak > off` 语义校验兜底。
			 */
			const buildFrom = (indices) => {
				const draft = {};
				for (const id of modelIds) draft[id] = { label: id, cacheHit: {}, cacheMiss: {}, output: {} };
				const kinds = ["cacheHit", "cacheHit", "cacheMiss", "cacheMiss", "output", "output"];
				for (let position = 0; position < 6; position += 1) {
					const values = numericOf(rows[indices[position]]);
					const picked = values.slice(values.length - columnCount);
					const tier = position % 2 === 0 ? "off" : "peak";
					modelIds.forEach((id, column) => {
						const value = picked[column];
						if (Number.isFinite(value) && value >= 0) draft[id][kinds[position]][tier] = value;
					});
				}
				return draft;
			};

			/**
			 * 校验：三类别两档齐全，且峰时价**严格大于**闲时价。
			 *
			 * 这条自证很值钱：官方规则是「闲时价 = 峰时价的一半」，
			 * 所以如果组合取错位（把并发限制当成价格、或档位配反），
			 * 数值虽在但关系不成立 —— 宁可判定解析失败、回落内置表，
			 * 也不要把错的价拿去算钱。
			 */
			const isValid = (draft) => {
				for (const id of modelIds) {
					for (const kind of ["cacheHit", "cacheMiss", "output"]) {
						const pair = draft[id][kind];
						if (!Number.isFinite(pair.peak) || !Number.isFinite(pair.off)) return false;
						if (pair.peak <= pair.off) return false;
					}
				}
				return true;
			};

			// 枚举"从某候选行起的连续 6 行"组合，取第一个通过校验的
			let models = null;
			for (let start = 0; start < candidates.length && models === null; start += 1) {
				const indices = [candidates[start]];
				for (let next = start + 1; next < candidates.length; next += 1) {
					if (candidates[next] !== indices[indices.length - 1] + 1) break;
					indices.push(candidates[next]);
					if (indices.length === 6) break;
				}
				if (indices.length !== 6) continue;
				const draft = buildFrom(indices);
				if (draft !== null && isValid(draft)) models = draft;
			}
			if (models === null) return null;
			if (Object.keys(models).length === 0) return null;
			return { models, capturedAt: new Date().toISOString() };
		}

		/**
		 * 合并价格来源：内置表 + 同步结果。
		 *
		 * 同步结果**优先**，但只覆盖它能解析出的模型；内置表里没被同步到的仍然保留。
		 * 这样"官方新增模型"与"官方老模型下架"都不会把表弄空。
		 *
		 * @param synced - `{ models, capturedAt }` 或 null。
		 * @returns `{ prices, source, capturedAt }`：source 为 `'synced' | 'builtin'`。
		 */
		function resolvePrices(synced) {
			if (synced === null || synced === undefined || typeof synced.models !== "object") {
				return { prices: PRICES, source: "builtin", capturedAt: BUILTIN_PRICES_DATE };
			}
			return {
				prices: { ...PRICES, ...synced.models },
				source: "synced",
				capturedAt: synced.capturedAt ?? null
			};
		}

		/**
		 * 读某个会话**实际在用**的模型。
		 *
		 * 为什么需要这个：插件原来只有一个全局「计价模型」下拉，可一个会话中途
		 * 换过模型、或者不同会话用不同模型时，单一设置必然算错。
		 * DSH 自己就是权威来源，所以直接问它，不再靠用户猜着选。
		 *
		 * 取值优先级（都是 DSH 公开接口，且都是只读）：
		 * 1. `session.requestContext()` → `{ provider, model }`：当前请求上下文，最直接。
		 * 2. `session.requestHeader().config.model`：最近一次请求头的配置。
		 * 3. `session.deriveMessages()` 里最后一条助手消息的 `source.model`：
		 *    会话日志里每条助手消息都带生成它的模型，这是最贴近"实际用了什么"的痕迹。
		 *
		 * @param session - 会话对象（`ctx.sessions.binding(id).session`）。
		 * @returns 模型 id；拿不到时返回 undefined（调用方回落到用户设置）。
		 */
		function sessionModelOf(session) {
			if (session === undefined || session === null) return undefined;
			const clean = (value) => (typeof value === "string" && value.length > 0 ? value : undefined);
			try {
				const fromContext = clean(session.requestContext?.()?.model);
				if (fromContext !== undefined) return fromContext;
			} catch {
				// 接口不存在或被拒绝，继续往下试
			}
			try {
				const fromHeader = clean(session.requestHeader?.()?.config?.model);
				if (fromHeader !== undefined) return fromHeader;
			} catch {
				// 同上
			}
			try {
				const messages = session.deriveMessages?.();
				if (Array.isArray(messages)) {
					// 从后往前找第一条有 model 的助手消息
					for (let i = messages.length - 1; i >= 0; i -= 1) {
						const found = clean(messages[i]?.source?.model);
						if (found !== undefined) return found;
					}
				}
			} catch {
				// 同上
			}
			return undefined;
		}

		/**
		 * 这个会话一共用过哪些模型（按使用顺序去重）。
		 *
		 * 用途是**如实告知**：`tokenUsage` 投影是整个会话的聚合、没有模型维度，
		 * 所以一个会话如果混用过多个模型，按单一模型计价只能是估算。
		 * 把这个事实摆出来，比悄悄给个偏低的数好。
		 *
		 * @param session - 会话对象。
		 * @returns 模型 id 数组（可能为空）。
		 */
		function sessionModelsUsed(session) {
			const used = [];
			try {
				const messages = session?.deriveMessages?.();
				if (!Array.isArray(messages)) return used;
				for (const message of messages) {
					const model = message?.source?.model;
					if (typeof model === "string" && model.length > 0 && !used.includes(model)) used.push(model);
				}
			} catch {
				// 拿不到就当"未知"
			}
			return used;
		}

		/**
		 * 当前是否处于官方高峰时段。用本地时间换算出北京时间，只取「星期 + 小时」，
		 * 不引入任何时区库。
		 * @param now - 本地当前时间。
		 * @returns 是否按峰时价计费。
		 */
		function isPeakHour(now) {
			const beijing = new Date(now.getTime() + (480 + now.getTimezoneOffset()) * 60000);
			if (beijing.getDay() === 0 || beijing.getDay() === 6) return false;
			const minutes = beijing.getHours() * 60 + beijing.getMinutes();
			return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
		}

		/**
		 * 把一份用量折算成金额。
		 * @param usage - tokenUsage 投影（未缓存输入 / 缓存读 / 缓存写 / 输出）。
		 * @param model - 模型 id，未知时回落 flash。
		 * @param peak - 是否峰时价。
		 * @param prices - 价格表（可传同步来的表）；不传用内置表。
		 * @returns 明细与合计（元）。
		 */
		function costOf(usage, model, peak, prices) {
			if (usage === undefined || usage === null) return null;
			const table = prices ?? PRICES;
			const price = table[model] ?? table[FALLBACK_MODEL];
			const tier = peak ? "peak" : "off";
			// 缓存写按未命中输入计；数量级与官方扣费口径一致。
			const missTokens =
				(Number(usage.uncachedInputTokens) || 0) + (Number(usage.cacheWriteTokens) || 0);
			const hitTokens = Number(usage.cacheReadTokens) || 0;
			const outputTokens = Number(usage.outputTokens) || 0;
			const known = table[model] !== undefined;
			const parts = {
				model: known ? model : FALLBACK_MODEL,
				unknownModel: !known,
				usingPriceOf: known ? model : FALLBACK_MODEL,
				tier,
				missTokens,
				hitTokens,
				outputTokens,
				miss: (missTokens / 1e6) * price.cacheMiss[tier],
				hit: (hitTokens / 1e6) * price.cacheHit[tier],
				output: (outputTokens / 1e6) * price.output[tier]
			};
			parts.total = parts.miss + parts.hit + parts.output;
			parts.price = price;
			return parts;
		}
		//#endregion

		//#region 数字格式化
		function currencySymbol(currency) {
			return currency === "USD" ? "$" : "¥";
		}

		/**
		 * 余额：与官方设置页同口径（不足 0.01 显示 `<¥0.01`，四位小数）。
		 * @param value - 十进制字符串或数字。
		 * @param symbol - 币种符号。
		 * @returns 展示文本。
		 */
		function formatMoney(value, symbol) {
			const amount = Number(value);
			if (!Number.isFinite(amount)) return `${symbol}--`;
			if (amount <= 0) return `${symbol}0.00`;
			if (amount < 0.01) return `<${symbol}0.01`;
			return `${symbol}${amount.toLocaleString("zh-CN", {
				minimumFractionDigits: 2,
				maximumFractionDigits: 2
			})}`;
		}

		/**
		 * 小卡片用的花费文本：**精确到分（2 位小数）**。
		 * 日常一眼看清够用，字数也短。
		 *
		 * @param value - 金额（元）。
		 * @param symbol - 币种符号。
		 * @returns 展示文本，例如 `¥0.59`。
		 */
		function formatCostShort(value, symbol) {
			const amount = Number(value);
			if (!Number.isFinite(amount)) return `${symbol}--`;
			if (amount === 0) return `${symbol}0.00`;
			if (Math.abs(amount) < 0.005) return `${amount > 0 ? "<" : ">"}${symbol}0.01`;
			return `${amount < 0 ? "-" : ""}${symbol}${Math.abs(amount).toFixed(2)}`;
		}

		/**
		 * 明细面板用的花费文本：**4 位小数**。
		 *
		 * 为什么面板要多两位：token 量级的花费常常不足 1 分，2 位小数会全是 `0.00`，
		 * 看不出差别。仍然保留 `0.0001` 这颗"最小单位"的哨兵 —— 花了钱就绝不显示成 0。
		 *
		 * @param value - 金额（元）。
		 * @param symbol - 币种符号。
		 * @returns 展示文本，例如 `¥0.5900`。
		 */
		function formatCost(value, symbol) {
			const amount = Number(value);
			if (!Number.isFinite(amount)) return `${symbol}--`;
			if (amount === 0) return `${symbol}0.0000`;
			if (Math.abs(amount) < 0.0001) return `${amount > 0 ? "<" : ">"}${symbol}0.0001`;
			return `${amount < 0 ? "-" : ""}${symbol}${Math.abs(amount).toFixed(4)}`;
		}

		function formatTokens(count) {
			const value = Number(count) || 0;
			if (value < 1000) return String(value);
			if (value < 1e6) return `${(value / 1e3).toFixed(value < 1e4 ? 1 : 0)}k`;
			return `${(value / 1e6).toFixed(2)}M`;
		}

		/**
		 * 把时间戳格式化成 HH:MM:SS，用于面板里的"更新于 …"。
		 * @param timestamp - 毫秒时间戳。
		 * @returns 本地时间文本。
		 */
		function formatClock(timestamp) {
			try {
				const date = new Date(timestamp);
				const pad = (value) => String(value).padStart(2, "0");
				return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
			} catch {
				return "--:--:--";
			}
		}
		//#endregion

		//#region 余额读取
		/**
		 * 前台刷新间隔。开销参考：一次本地回环 GET（约 200 字节）+ Host 一次平台查询。
		 * 60 秒足够"看着不滞后"，同时把后台唤醒压到每分钟一次。
		 * 想更实时就调小；想更省电就调大。
		 */
		const BALANCE_POLL_MS = 60000;
		/** 页面不可见（切标签 / 最小化）时的间隔：挂机场景下把唤醒频率降到 12 次/小时。 */
		const BALANCE_POLL_HIDDEN_MS = 300000;
		/** 读取失败后的快速重试节奏（毫秒）；用完即回到 BALANCE_POLL_MS。 */
		const BALANCE_RETRY_MS = [1000, 2000, 5000, 10000, 20000];
		/** Host 半边注册的只读余额路由。 */
		const BALANCE_ROUTE = "/api/balance-hud/balance";
		/** 赠金信号路由（Host 半边只读、不回执）。用于印证"余额跳高"是不是官方赠金。 */
		const BONUS_ROUTE = "/api/balance-hud/bonuses";

		//#region 峰谷时间助手

		/** 北京时间相对 UTC 的分钟偏移（+8 小时）。 */
		const BEIJING_OFFSET_MINUTES = 480;
		/** 峰时时段（北京时间，按当天分钟计）：09:00–12:00 与 14:00–18:00。 */
		const PEAK_WINDOWS = [
			[9 * 60, 12 * 60],
			[14 * 60, 18 * 60]
		];

		/**
		 * 把任意时刻换算成"北京时间当天的分钟数 + 星期"。
		 * @param now - 本地时间。
		 * @returns `{ minutes, day }`；day 为 0=周日。
		 */
		function beijingClock(now) {
			const beijing = new Date(now.getTime() + (BEIJING_OFFSET_MINUTES + now.getTimezoneOffset()) * 60000);
			return { minutes: beijing.getHours() * 60 + beijing.getMinutes(), day: beijing.getDay() };
		}

		/**
		 * 当前是否峰时（官方计费口径）。
		 * @param now - 本地当前时间。
		 * @returns 是否按峰时价计费。
		 */
		function isPeakHour(now) {
			const { minutes, day } = beijingClock(now);
			if (day === 0 || day === 6) return false;
			return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to);
		}

		/**
		 * 距离下一次**计价档位切换**还有多少分钟。
		 *
		 * 用来做"即将进入峰时"的提醒：峰时价是闲时的**正好两倍**，
		 * 所以提前知道"还能便宜几分钟"是实打实的省钱信息。
		 * 周末与跨天都要算对：周六/周日整天都是闲时，下一次切换是周一 09:00。
		 *
		 * @param now - 本地当前时间。
		 * @returns `{ minutes, to }`，to 为 `'peak'`（即将进入峰时）或 `'off'`（即将回到闲时）。
		 */
		function minutesUntilTierChange(now) {
			const { minutes, day } = beijingClock(now);
			const isWeekend = day === 0 || day === 6;
			if (isWeekend) {
				// 周末：下一次切换一定是"进入峰时"。周六 → 周一 09:00；周日 → 周一 09:00。
				const daysToMonday = day === 6 ? 2 : 1;
				return { minutes: daysToMonday * 24 * 60 - minutes + PEAK_WINDOWS[0][0], to: "peak" };
			}
			const peak = PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to);
			if (peak) {
				// 峰时中：走向本段结束（12:00 或 18:00）
				const current = PEAK_WINDOWS.find(([from, to]) => minutes >= from && minutes < to);
				return { minutes: current[1] - minutes, to: "off" };
			}
			// 闲时中：走向下一段峰时的开始（09:00 / 14:00 / 次日 09:00）
			const nextStart = PEAK_WINDOWS.map(([from]) => from).find((from) => from > minutes);
			if (nextStart !== undefined) return { minutes: nextStart - minutes, to: "peak" };
			return { minutes: 24 * 60 - minutes + PEAK_WINDOWS[0][0], to: "peak" };
		}
		//#endregion

		//#region 界面语言（i18n）

		/**
		 * 这个插件自己的文案表：**中文为准，英文逐条对应**。
		 *
		 * 为什么自带一份而不是只用 DSH 的字典：DSH 的 `locale.register` 要求
		 * 每种内置语言都给全，且要挂到一个已声明的 namespace 上；而我们的
		 * bundle 是手写的、没有构建期类型合并，所以自带一份更直接。
		 * DSH 的 locale 服务只用来读"用户当前选了哪个语言"。
		 *
		 * 术语约定（英文侧）：spend 说 "spend"，session 说 "this session"，
		 * 峰/闲时说 "peak"/"off-peak"，预算说 "budget"。
		 */
		const MESSAGES = {
			zh: {
    cardAriaLabel: '余额与本会话花费',
    panelAccountBalance: '账户余额',
    panelSessionSpend: '本会话花费',
    panelNoUsage: '当前会话无用量数据',
    panelTokens: 'Token 用量',
    panelShare: '本会话占比',
    panelOtherSessions: '其它会话',
    panelTrackedSessions: '跟踪会话',
    panelSessionId: '会话',
    panelPricedBy: '计价模型',
    panelPricedByMixed: '（混用 {n} 个，估算）',
    panelSessionCount: '{n} 个',
    unknownModelNotice: '未知模型「{model}」，暂按 {fallback} 的价格估算。',
    panelFootnote: '预估 = token 用量 × 官方价格表（缓存写按未命中价）。实际扣费 = 累计的余额减少量，按会话分别存本地，刷新与切换会话都不丢。识别到充值（余额升幅超过 token 估算上界）时只抬起基线、不打断计数，所以花费持续累计；判错了可以点「我刚充值了」手动纠正。面板 4 位小数，小卡片 2 位。',
    stateLoading: '读取中',
    stateLoadingEllipsis: '读取中…',
    stateSignedOut: '未登录',
    stateFailed: '读取失败',
    stateNoUsage: '本会话预估 无用量',
    stateWaitingBalance: '等待余额',
    stateWaitingFirstRead: '等首次读数',
    stateReason: '原因',
    stateStatus: '状态',
    refresh: '刷新',
    refreshing: '刷新中…',
    refreshingShort: '刷新中',
    justUpdated: '刚刚更新',
    updatedAt: '更新于 {time}',
    accountTotal: '账户级合计',
    justNow: '当前',
    detailMiss: '未命中输入',
    detailCacheHit: '缓存命中',
    detailOutput: '输出花费',
    sessionEstimate: '本会话预估',
    actualSpend: '实际扣费',
    sessionApportioned: '本会话分摊',
    balanceTopup: '充值余额',
    balanceBonus: '赠金余额',
    balanceTotal: '合计余额',
    tierPeak: '峰时',
    tierOff: '闲时',
    tierPeakPrice: '峰时价',
    tierOffPrice: '闲时价',
    markTopUp: '我刚充值了',
    checking: '查询中…',
    topUpAnchored: '已按你的标记重锚基线',
    topUpNotifyTitle: '余额 HUD 预算提醒',
    budgetLabel: '预算',
    budgetSessionUsed: '本会话已用',
    budgetDailyUsed: '今日已用',
    budgetOver: '已超限',
    budgetCritical: '接近上限',
    budgetWarn: '注意用量',
    budgetRemaining: '，还剩 {amount}',
    budgetNotifyTitle: '余额 HUD 预算提醒',
    peakWarningIn: '约 {n} 分钟后进入峰时，价格翻倍',
    peakWarningOut: '约 {n} 分钟后回到闲时价',
    settingsTitle: '余额与花费 HUD',
    settingsSubtitle: '右下角浮层的计价与告警设置',
    settingsModel: '计价模型',
    settingsModelFollow: '计价模型跟随会话',
    settingsModelFollowHint: '打开时按每个会话实际使用的模型计价（DSH 说了算），避免选错模型把花费算错；关掉则一律用上面选的模型。',
    settingsPoll: '前台刷新间隔',
    settingsHiddenPoll: '后台（页面隐藏）',
    settingsPeakLead: '峰前提醒',
    settingsSessionBudget: '本会话预算（元）',
    settingsDailyBudget: '每日预算（元）',
    settingsShowAccountTotal: '显示账户级合计',
    settingsNotifyPeak: '峰时提醒',
    settingsNotifyBudget: '预算超限发系统通知',
    settingsSync: '自动同步价格',
    settingsSyncManual: '不自动（只手动）',
    settingsSyncEveryHours: '每 {n} 小时',
    settingsSyncEveryDays: '每 {n} 天',
    settingsSyncNow: '同步价格',
    settingsPriceSource: '当前价格',
    settingsPriceBuiltin: '内置表（{date}）',
    settingsPriceSynced: '已同步（{date}）',
    settingsSyncUnchanged: '价格未变更',
    settingsSyncUpdated: '价格已更新（{n} 个模型）',
    settingsSyncFailed: '同步失败',
    settingsLanguage: '界面语言',
    settingsLanguageAuto: '跟随 DSH',
    settingsLanguageZh: '中文',
    settingsLanguageEn: 'English',
    settingsLanguageResolved: '（当前：{label}）',
    settingsBudgetPlaceholder: '0 = 不设',
    settingsFootnote: '峰时价是闲时的两倍；预算按累计花费计算，充值不影响。设置立即生效，存在浏览器本地。',
    settingsPrivacyFootnote: '「同步价格」会访问官方文档页 api-docs.deepseek.com 读取最新价目表；不点它、也不选自动间隔时，插件不会发出任何对外请求。'
			},
			en: {
    cardAriaLabel: 'Balance and spend for this session',
    panelAccountBalance: 'Account balance',
    panelSessionSpend: 'Session spend',
    panelNoUsage: 'No usage data for this session',
    panelTokens: 'Token usage',
    panelShare: 'Session share',
    panelOtherSessions: 'Other sessions',
    panelTrackedSessions: 'Tracked sessions',
    panelSessionId: 'Session',
    panelPricedBy: 'Priced by',
    panelPricedByMixed: '({n} models mixed, estimated)',
    panelSessionCount: '{n}',
    unknownModelNotice: 'Unknown model "{model}"; priced as {fallback} for now.',
    panelFootnote: 'Estimate = token usage x the official price table (cache writes billed at the uncached rate). Actual spend = accumulated balance decrease, kept per session, so refreshing or switching sessions loses nothing. A detected top-up (a rise beyond the token-estimate bound) only lifts the baseline, so spend keeps accumulating; if that is wrong, click "I just topped up" to correct it. The panel shows 4 decimals, the small card 2.',
    stateLoading: 'Loading',
    stateLoadingEllipsis: 'Loading...',
    stateSignedOut: 'Not signed in',
    stateFailed: 'Read failed',
    stateNoUsage: 'Session estimate: no usage',
    stateWaitingBalance: 'Waiting for balance',
    stateWaitingFirstRead: 'Waiting for first read',
    stateReason: 'Reason',
    stateStatus: 'Status',
    refresh: 'Refresh',
    refreshing: 'Refreshing...',
    refreshingShort: 'Refreshing',
    justUpdated: 'just now',
    updatedAt: 'updated {time}',
    accountTotal: 'Account total',
    justNow: 'now',
    detailMiss: 'Uncached input',
    detailCacheHit: 'Cache hits',
    detailOutput: 'Output cost',
    sessionEstimate: 'Session estimate',
    actualSpend: 'Actual spend',
    sessionApportioned: 'Session share',
    balanceTopup: 'Top-up balance',
    balanceBonus: 'Bonus balance',
    balanceTotal: 'Total balance',
    tierPeak: 'Peak',
    tierOff: 'Off-peak',
    tierPeakPrice: 'peak price',
    tierOffPrice: 'off-peak price',
    markTopUp: 'I just topped up',
    checking: 'Checking...',
    topUpAnchored: 'Baseline re-anchored to your mark',
    topUpNotifyTitle: 'Balance HUD budget alert',
    budgetLabel: 'Budget',
    budgetSessionUsed: 'session used',
    budgetDailyUsed: 'today used',
    budgetOver: 'over budget',
    budgetCritical: 'near limit',
    budgetWarn: 'watch usage',
    budgetRemaining: ', {amount} left',
    budgetNotifyTitle: 'Balance HUD budget alert',
    peakWarningIn: 'Peak pricing in ~{n} min - price doubles',
    peakWarningOut: 'Off-peak pricing returns in ~{n} min',
    settingsTitle: 'Balance and spend HUD',
    settingsSubtitle: 'Pricing and alert settings for the bottom-right overlay',
    settingsModel: 'Pricing model',
    settingsModelFollow: 'Follow the session\'s model',
    settingsModelFollowHint: 'When on, each session is priced by the model it actually used (DSH decides), so a wrong selection cannot misprice it. When off, the model chosen above is always used.',
    settingsPoll: 'Foreground interval',
    settingsHiddenPoll: 'Background (page hidden)',
    settingsPeakLead: 'Peak warning lead',
    settingsSessionBudget: 'Session budget (CNY)',
    settingsDailyBudget: 'Daily budget (CNY)',
    settingsShowAccountTotal: 'Show account total row',
    settingsNotifyPeak: 'Peak-hour warnings',
    settingsNotifyBudget: 'System notification on budget breach',
    settingsSync: 'Auto-sync prices',
    settingsSyncManual: 'Off (manual only)',
    settingsSyncEveryHours: 'Every {n} h',
    settingsSyncEveryDays: 'Every {n} days',
    settingsSyncNow: 'Sync prices',
    settingsPriceSource: 'Current prices',
    settingsPriceBuiltin: 'built-in ({date})',
    settingsPriceSynced: 'synced ({date})',
    settingsSyncUnchanged: 'Prices unchanged',
    settingsSyncUpdated: 'Prices updated ({n} models)',
    settingsSyncFailed: 'Sync failed',
    settingsLanguage: 'Interface language',
    settingsLanguageAuto: 'Follow DSH',
    settingsLanguageZh: '中文',
    settingsLanguageEn: 'English',
    settingsLanguageResolved: '(now: {label})',
    settingsBudgetPlaceholder: '0 = unset',
    settingsFootnote: 'Peak pricing is exactly 2x off-peak. Budgets count confirmed spend only, so a top-up never triggers them. Changes apply immediately and live in this browser.',
    settingsPrivacyFootnote: '"Sync prices" fetches the latest price table from the official docs page at api-docs.deepseek.com. Until you click it or pick an auto-sync interval, the plugin makes no outbound request at all.'
			}
		};

		/** 这个插件在 DSH 语言目录里的命名空间（只用于显示，不注册字典）。 */
		const LOCALE_NS = "balance-hud";

		/**
		 * 把 DSH 报的 locale id 归一成我们支持的两选一。
		 *
		 * **按前缀匹配而不是全等**：内置 id 可能是 `zh-CN`，也可能是 `zh-Hans`
		 * 甚至 `zh-Hans-CN`；写死一个拼写的话，另一种拼写下中文用户会看到英文界面。
		 * 认不出的一律当英文（国际默认）。
		 *
		 * @param id - DSH 的 `locale.getLocale().active`。
		 * @returns `'zh'` 或 `'en'`。
		 */
		function normalizeLang(id) {
			if (typeof id !== "string") return "en";
			return id.toLowerCase().startsWith("zh") ? "zh" : "en";
		}

		/**
		 * 解析当前该用哪种界面语言。
		 *
		 * 优先级：用户在本插件设置里显式选的语言 > DSH 当前语言 > 中文。
		 * （兜底中文而不是英文：这个插件的原始受众是中文用户，且历史文案就是中文，
		 * 读不到 DSH locale 时保持原样最不意外。）
		 *
		 * @param uiLanguage - 设置里的 `uiLanguage`（`auto` / `zh` / `en`）。
		 * @param dshLocaleId - DSH 当前 locale id，拿不到就传 undefined。
		 * @returns `'zh'` 或 `'en'`。
		 */
		function resolveLang(uiLanguage, dshLocaleId) {
			if (uiLanguage === "zh" || uiLanguage === "en") return uiLanguage;
			if (typeof dshLocaleId === "string" && dshLocaleId.length > 0) return normalizeLang(dshLocaleId);
			return "zh";
		}

		/**
		 * 取一条文案并替换 `{name}` 占位。
		 *
		 * 缺键时**回落到中文原文**，而不是显示键名 —— 键名对用户毫无意义。
		 *
		 * @param lang - `'zh'` 或 `'en'`。
		 * @param key - 文案键。
		 * @param vars - 占位替换表。
		 * @returns 可直接显示的字符串。
		 */
		function translate(lang, key, vars) {
			const table = MESSAGES[lang] ?? MESSAGES.zh;
			let text = table[key] ?? MESSAGES.zh[key] ?? key;
			if (vars !== undefined && vars !== null) {
				for (const [name, value] of Object.entries(vars)) {
					text = text.split(`{${name}}`).join(String(value));
				}
			}
			return text;
		}

		/**
		 * 读 DSH 当前语言 id。
		 *
		 * `locale` 是客户端服务，通过 `ctx.get("locale")` 取（官方推荐的可选依赖写法）。
		 * 拿不到就返回 undefined，由 `resolveLang` 兜底。
		 *
		 * @param ctx - 客户端 Cordis 上下文。
		 * @returns locale id 或 undefined。
		 */
		function readDshLocaleId(ctx) {
			try {
				const locale = ctx?.get?.("locale");
				const snapshot = locale?.getLocale?.() ?? locale?.getSnapshot?.();
				const active = snapshot?.active;
				return typeof active === "string" && active.length > 0 ? active : undefined;
			} catch {
				return undefined;
			}
		}

		/**
		 * 订阅 DSH 语言变化，变化时回调（用于让已渲染的界面立刻换语言）。
		 *
		 * @param ctx - 客户端 Cordis 上下文。
		 * @param onChange - 变化回调。
		 * @returns 取消订阅函数（拿不到服务时是空函数）。
		 */
		function subscribeDshLocale(ctx, onChange) {
			try {
				const locale = ctx?.get?.("locale");
				if (typeof locale?.subscribe !== "function") return () => {};
				return locale.subscribe(onChange);
			} catch {
				return () => {};
			}
		}

		//#endregion

		//#region 配置

		/** 配置持久化的 localStorage 键（与记账数据分开，互不影响）。 */
		const SETTINGS_KEY = "dsh-balance-hud:settings:v1";
		/** 可选模型（面板与设置里的下拉项）。 */
		const MODEL_CHOICES = [FALLBACK_MODEL, "deepseek-v4-pro"];
		/** 可选轮询间隔（秒）。 */
		const POLL_CHOICES = [30, 60, 120, 300];
		/** 可选峰前提醒提前量（分钟）。 */
		const PEAK_WARN_CHOICES = [5, 10, 15, 30];

		/**
		 * 默认配置。
		 *
		 * @returns 全新的默认配置对象。
		 */
		function defaultSettings() {
			return {
				/** 计价用的模型；未知模型会回落到 flash。 */
				model: FALLBACK_MODEL,
				/** 前台轮询间隔（秒）。 */
				pollSeconds: 60,
				/** 后台（页面隐藏）轮询间隔（秒）。 */
				hiddenPollSeconds: 300,
				/** 面板里是否显示t("accountTotal")这一参照行。 */
				showAccountTotal: true,
				/** 本会话预算（元）；0 表示不设。 */
				sessionBudget: 0,
				/** 每日预算（元）；0 表示不设。 */
				dailyBudget: 0,
				/** 是否在达到预算阈值时发系统通知。 */
				notifyBudget: false,
				/** 是否做"即将进入峰时"提醒。 */
				notifyPeak: true,
				/** 峰前提前量（分钟）。 */
				peakWarnMinutes: 10,
				/** 价格自动同步间隔（小时）；0 = 不自动同步（默认，零外联）。 */
				syncHours: 0,
				/** 计价模型是否跟随会话实际使用的模型（默认跟随，避免选错模型算错价）。 */
				modelFollowsSession: true,
				/** 界面语言：uto 跟随 DSH，或强制 zh / en。 */
				uiLanguage: "auto"
			};
		}

		/**
		 * 把任意来源的对象收敛成合法配置：逐字段校验，非法值回落默认。
		 *
		 * 为什么这么啰嗦：配置存在 localStorage，用户可能手改、版本升级也可能留下旧字段。
		 * 与其相信它，不如每次都过一遍白名单 —— 这样任何脏数据都不会让 HUD 崩掉。
		 *
		 * @param raw - 待收敛的对象。
		 * @returns 合法配置。
		 */
		function normalizeSettings(raw) {
			const base = defaultSettings();
			if (raw === null || typeof raw !== "object") return base;
			const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
			const number = (value, fallback, min, max) => {
				const parsed = Number(value);
				if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
				return parsed;
			};
			return {
				model: pick(raw.model, MODEL_CHOICES, base.model),
				pollSeconds: pick(Number(raw.pollSeconds), POLL_CHOICES, base.pollSeconds),
				hiddenPollSeconds: pick(Number(raw.hiddenPollSeconds), POLL_CHOICES, base.hiddenPollSeconds),
				showAccountTotal: typeof raw.showAccountTotal === "boolean" ? raw.showAccountTotal : base.showAccountTotal,
				sessionBudget: number(raw.sessionBudget, base.sessionBudget, 0, 100000),
				dailyBudget: number(raw.dailyBudget, base.dailyBudget, 0, 1000000),
				notifyBudget: typeof raw.notifyBudget === "boolean" ? raw.notifyBudget : base.notifyBudget,
				notifyPeak: typeof raw.notifyPeak === "boolean" ? raw.notifyPeak : base.notifyPeak,
				peakWarnMinutes: pick(Number(raw.peakWarnMinutes), PEAK_WARN_CHOICES, base.peakWarnMinutes),
				syncHours: pick(Number(raw.syncHours), SYNC_INTERVAL_HOURS, base.syncHours),
				modelFollowsSession: pick(raw.modelFollowsSession, [true, false], base.modelFollowsSession),
				uiLanguage: pick(raw.uiLanguage, ["auto", "zh", "en"], base.uiLanguage)
			};
		}

		/**
		 * 从 localStorage 读配置（读不到或损坏则回落默认）。
		 * @returns 合法配置。
		 */
		function loadSettings() {
			try {
				const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
				if (raw === null || raw === undefined) return defaultSettings();
				return normalizeSettings(JSON.parse(raw));
			} catch {
				return defaultSettings();
			}
		}

		/**
		 * 写回配置。
		 * @param settings - 合法配置。
		 */
		function saveSettings(settings) {
			try {
				globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
			} catch {
				// localStorage 不可用：本次会话内仍然生效，只是不持久。
			}
		}

		/**
		 * 做一个"能被多处读写"的配置容器。
		 *
		 * 为什么不用 React state：HUD 浮层和设置里的那一行是**两个独立的注册点**，
		 * 它们没有共同的 React 祖先。用一个带订阅的小容器把它们连起来，
		 * 任一处保存，另一处立刻看到。
		 *
		 * @returns 配置容器：`get` / `set` / `subscribe`。
		 */
		function createSettingsStore() {
			let current = loadSettings();
			const listeners = new Set();
			return {
				get: () => current,
				/**
				 * 合并一份改动并广播。
				 * @param patch - 要改的字段。
				 * @returns 收敛后的新配置。
				 */
				set(patch) {
					current = normalizeSettings({ ...current, ...patch });
					saveSettings(current);
					for (const listener of listeners) {
						try {
							listener(current);
						} catch {
							// 单个订阅者出错不影响其它
						}
					}
					return current;
				},
				/**
				 * 订阅变更。
				 * @param listener - 回调。
				 * @returns 取消订阅。
				 */
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				}
			};
		}

		/**
		 * 在 React 组件里订阅配置容器。`useState` 由外部注入，避免依赖具体 React 版本。
		 * @param store - 配置容器。
		 * @param useState - 组件作用域里的 React.useState。
		 * @param useEffect - 组件作用域里的 React.useEffect。
		 * @returns 当前配置。
		 */
		function useSettings(store, useState, useEffect) {
			const [value, setValue] = useState(store.get());
			useEffect(() => store.subscribe(setValue), [store]);
			return value;
		}

		//#region 预算

		/** 预算档位：使用率达到这些比例时升级告警级别。 */
		const BUDGET_STEPS = [
			{ at: 1, level: "over" },
			{ at: 0.9, level: "critical" },
			{ at: 0.75, level: "warn" }
		];

		/**
		 * 评估一条预算。
		 *
		 * @param spent - 已花费（元）。
		 * @param budget - 预算额度（元）；0 表示未设。
		 * @returns `{ level, ratio, remaining }`：level 为 `'none' | 'warn' | 'critical' | 'over'`。
		 */
		function evaluateBudget(spent, budget) {
			if (!(budget > 0) || typeof spent !== "number") {
				return { level: "none", ratio: 0, remaining: undefined };
			}
			const ratio = spent / budget;
			const step = BUDGET_STEPS.find((item) => ratio >= item.at);
			return {
				level: step ? step.level : "none",
				ratio,
				remaining: Math.max(0, budget - spent)
			};
		}

		/**
		 * 取两条预算里更严重的那条，用于给卡片上色。
		 * @param levels - 若干 level。
		 * @returns 最严重的一个。
		 */
		function worstBudgetLevel(levels) {
			const order = { none: 0, warn: 1, critical: 2, over: 3 };
			return levels.reduce((worst, level) => (order[level] > order[worst] ? level : worst), "none");
		}

		/** 预算级别对应的强调色（与 DSH 主题变量回退值一致）。 */
		const BUDGET_COLORS = {
			warn: "var(--dsw-alias-label-warning, #b7791f)",
			critical: "var(--dsw-alias-label-warning, #c05621)",
			over: "var(--dsw-alias-label-error, #c53030)"
		};

		/** 每日花费台账的 localStorage 键。 */
		const DAILY_KEY = "dsh-balance-hud:daily:v1";

		/**
		 * 取"北京时间今天"的 `YYYY-MM-DD`。
		 *
		 * 为什么用北京时间而不是本地日期：官方计价、峰谷判定都按北京时间，
		 * 日预算跟着同一个口径才不会在跨时区时错位。
		 *
		 * @param now - 本地时间。
		 * @returns 日期字符串。
		 */
		function beijingDateKey(now) {
			const beijing = new Date(now.getTime() + (BEIJING_OFFSET_MINUTES + now.getTimezoneOffset()) * 60000);
			const month = String(beijing.getMonth() + 1).padStart(2, "0");
			const day = String(beijing.getDate()).padStart(2, "0");
			return `${beijing.getFullYear()}-${month}-${day}`;
		}

		/**
		 * 读每日花费台账。
		 *
		 * 只存**当天一条** `{ date, total }`：跨天即归零重开，所以不需要保留历史，
		 * 天然不会无限增长。
		 *
		 * @returns `{ date, total }`：date 为今天（北京时间），total 为今天累计花费。
		 */
		function loadDaily() {
			try {
				const raw = globalThis.localStorage?.getItem(DAILY_KEY);
				if (raw === null || raw === undefined) return { date: beijingDateKey(new Date()), total: 0 };
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return { date: beijingDateKey(new Date()), total: 0 };
				const today = beijingDateKey(new Date());
				if (parsed.date !== today) {
					// 跨天：昨天之前的账不再累计，今天是新的起点
					saveDaily({ date: today, total: 0 });
					return { date: today, total: 0 };
				}
				return { date: today, total: typeof parsed.total === "number" ? parsed.total : 0 };
			} catch {
				return { date: beijingDateKey(new Date()), total: 0 };
			}
		}

		/**
		 * 写每日台账。
		 * @param value - `{ date, total }`。
		 */
		function saveDaily(value) {
			try {
				globalThis.localStorage?.setItem(DAILY_KEY, JSON.stringify(value));
			} catch {
				// 存不下就只在内存里算
			}
		}

		/**
		 * 把一次"确认花费"记进今天的台账。
		 *
		 * 只由**确认值**驱动（余额读数确认的那部分），不用递推显示值 ——
		 * 否则同一笔钱会被反复累加。
		 *
		 * @param amount - 本次新增的确认花费。
		 * @returns 更新后的今日累计。
		 */
		function addDailySpent(amount) {
			if (!(amount > 0)) return loadDaily().total;
			const state = loadDaily();
			const next = { date: state.date, total: state.total + amount };
			saveDaily(next);
			return next.total;
		}
		//#endregion
		//#endregion

		//#region 余额读取
		/**
		 * 当前该用的刷新间隔：页面可见性与用户的轮询设置共同决定。
		 *
		 * @param settings - 当前配置。
		 * @returns 毫秒间隔。
		 */
		function pollInterval(settings) {
			try {
				if (globalThis.document?.hidden === true) {
					return (settings?.hiddenPollSeconds ?? BALANCE_POLL_HIDDEN_MS / 1000) * 1000;
				}
				return (settings?.pollSeconds ?? BALANCE_POLL_MS / 1000) * 1000;
			} catch {
				return BALANCE_POLL_MS;
			}
		}

		/**
		 * 读一次账户余额。
		 *
		 * **为什么走 HTTP 而不是 `ctx.remote.account`**：客户端插件的 `ctx.remote`
		 * 受 Cordis 依赖守卫保护，未声明就访问会抛
		 * `cannot get property "remote.account" without inject`；而客户端侧声明
		 * `inject = ["remote"]` 又无法满足（fiber 一直挂起）。所以余额由 **Host 半边**
		 * 通过 `ctx.deepseekAccount` 读取，经只读回环路由交给这里。协议不变，仍是三态：
		 * - `{ kind: "ready", currency, rechargeTotal, bonusTotal, total }` 已登录且拿到钱包；
		 * - `{ kind: "unavailable", reason }` 未登录 / 凭据变更；
		 * - `{ kind: "error", reason }` 查询失败、路由不可达、响应不合法。
		 *
		 * @returns 上述三态之一。
		 */
		async function readBalance() {
			let response;
			try {
				response = await fetch(BALANCE_ROUTE, {
					method: "GET",
					headers: { accept: "application/json" },
					cache: "no-store"
				});
			} catch (error) {
				return {
					kind: "error",
					reason: `余额路由不可达：${error && error.message ? error.message : String(error)}`
				};
			}
			if (!response.ok) {
				return { kind: "error", reason: `余额路由返回 HTTP ${response.status}` };
			}
			let payload;
			try {
				payload = await response.json();
			} catch {
				return { kind: "error", reason: "余额路由返回了非 JSON 内容" };
			}
			if (payload?.kind !== "ready" && payload?.kind !== "unavailable" && payload?.kind !== "error") {
				return { kind: "error", reason: `余额路由返回了未知形状：${JSON.stringify(payload)?.slice(0, 120)}` };
			}
			return payload;
		}

		/**
		 * 读官方「未回执的赠金」列表（只读、不回执）。
		 *
		 * **仅作充值的印证信号**：余额跳高时拿它判断是不是官方发的赠金。
		 * 因为**不回执**（Host 不调 `ackBonusNotified`），所以不会影响 DSH 自己的赠金通知，
		 * 这份数据会一直可读；本地用 orderId 去重即可。
		 *
		 * 失败一律降级为空列表：印证只是加分项，判据主体仍是 token 估算上界。
		 *
		 * @returns 赠金条目数组（含 orderId / amount / grantedAt）。
		 */
		async function readBonuses() {
			try {
				const response = await fetch(BONUS_ROUTE, {
					method: "GET",
					headers: { accept: "application/json" },
					cache: "no-store"
				});
				if (!response.ok) return [];
				const payload = await response.json();
				if (payload?.kind !== "ready" || !Array.isArray(payload.bonuses)) return [];
				return payload.bonuses;
			} catch {
				return [];
			}
		}
		//#endregion

		//#region HUD 组件
		const SANS =
			'var(--dsh-font-family-sans, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif)';

		const rootStyle = {
			// 钉在右下角；宽度由内容决定，折叠时自动收紧。
			position: "fixed",
			right: "14px",
			bottom: "12px",
			zIndex: 60,
			display: "flex",
			flexDirection: "column",
			alignItems: "flex-end",
			// 玻璃层负责把鼠标事件交给子元素；卡片与面板各自 auto。
			pointerEvents: "none",
			fontFamily: SANS
		};

		/**
		 * 卡片与面板共用的外层容器。
		 *
		 * **刻意不把悬停判定挂在它身上**：面板宽 286px、卡片窄（约 96px）且靠右，
		 * 两者错开形成的区域**不是矩形** —— 任何单一容器的盒子都会多出"左边有、下面没有"
		 * 的一块空白。用容器盒判断，指针往左滑进那块空白时不会收起，也就是
		 * 「左侧感觉是详情页的左侧，而我要的是小卡片的左侧」。
		 *
		 * 所以悬停改由**两个元素各自**的 mouseenter / mouseleave 承担（见 hoverOn / hoverOff），
		 * "面板的左边"与"卡片的左边"成为两件独立的事。容器只负责右对齐与 8px 视觉留白。
		 */
		const hoverSurfaceStyle = {
			display: "flex",
			flexDirection: "column",
			alignItems: "flex-end",
			gap: "8px"
		};

		/**
		 * 卡片用**两列网格**：标签列与数值列各自对齐。
		 * 三行的标签左对齐、金额右对齐，数字位数变化时列宽也不再跳动。
		 */
		const cardStyle = {
			pointerEvents: "auto",
			display: "inline-grid",
			gridTemplateColumns: "auto auto",
			columnGap: "10px",
			rowGap: "1px",
			padding: "6px 10px",
			borderRadius: "var(--dsw-radius-lg, 12px)",
			border: "0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
			background: "var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff))",
			boxShadow: "var(--dsw-elevation-prominent, 0 4px 16px rgba(0,0,0,.16))",
			color: "var(--dsw-alias-label-primary, #1b1b1f)",
			fontSize: "12px",
			lineHeight: "16px",
			cursor: "pointer",
			userSelect: "none",
			whiteSpace: "nowrap",
			maxWidth: "200px"
		};

		/** 网格里标签 / 数值的对齐方式。 */
		const gridLabelStyle = {
			color: "var(--dsw-alias-label-tertiary, #8a8a8f)",
			fontSize: "11px",
			textAlign: "left"
		};
		const gridValueStyle = {
			fontVariantNumeric: "tabular-nums",
			fontWeight: 500,
			textAlign: "right"
		};

		/** 折叠态：只留一个角标。 */
		const collapsedCardStyle = {
			...cardStyle,
			gridTemplateColumns: "auto",
			columnGap: 0,
			padding: "4px 8px",
			fontSize: "11px",
			lineHeight: "14px"
		};

		const labelStyle = { color: "var(--dsw-alias-label-tertiary, #8a8a8f)", fontSize: "11px" };
		const valueStyle = { fontVariantNumeric: "tabular-nums", fontWeight: 500 };
		/**
		 * 明细面板。
		 *
		 * **不再是 `position: fixed` + 硬编码 `bottom`**，而是「卡片外层」里的一个
		 * 普通流内子元素，两者之间用外层容器的 `gap: 8px` 留白。
		 *
		 * 关键差别：流内布局下，那段 8px 空白**属于外层容器自己的盒子**，指针经过它时
		 * 依然在外层容器内 —— 不会出现"指针跑到两个元素之间的空隙里、判定为移出"的漏判。
		 * 之前的 fixed + 硬编码偏移方案里，空白是真正的空档，才需要靠坐标计算去补。
		 */
		const panelStyle = {
			pointerEvents: "auto",
			width: "286px",
			boxSizing: "border-box",
			padding: "10px 12px",
			borderRadius: "var(--dsw-radius-lg, 12px)",
			border: "0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))",
			background: "var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff))",
			boxShadow: "var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.24))",
			color: "var(--dsw-alias-label-primary, #1b1b1f)",
			fontSize: "12px",
			lineHeight: "18px",
			fontFamily: SANS
		};

		const rowStyle = { display: "flex", justifyContent: "space-between", gap: "12px" };
		const hintStyle = {
			marginTop: "8px",
			paddingTop: "8px",
			borderTop: "0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))",
			color: "var(--dsw-alias-label-tertiary, #8a8a8f)",
			fontSize: "11px",
			lineHeight: "16px"
		};

		function Row(props) {
			return h(
				"div",
				{ style: rowStyle },
				h("span", { style: labelStyle }, props.label),
				h("span", { style: valueStyle }, props.value)
			);
		}

		/**
		 * 一行纯文本摘要，只喂给 `aria-label`（屏幕阅读器）。
		 *
		 * **不用于 `title`**：宿主此前把这份明细挂在 `title` 上，悬停约 1 秒后浏览器
		 * 会弹一个原生黑框 tooltip，与自绘的悬停面板重复且互相打架，已移除。
		 *
		 * @param balance - 余额三态。
		 * @param cost - 估价明细或 null。
		 * @param estimate - 本会话预估（递推值）；null 表示还没算出来。
		 * @param sessionId - 活动会话 id。
		 * @returns 单行摘要。
		 */
		function buildSummary(balance, cost, estimate, sessionId, modelInfo) {
			const parts = [];
			if (balance?.kind === "ready") {
				const symbol = currencySymbol(balance.currency);
				parts.push(`余额 ${formatMoney(balance.total, symbol)}`);
			} else if (balance === undefined) {
				parts.push("余额 读取中");
			} else if (balance.kind === "unavailable") {
				parts.push("余额 未登录");
			} else {
				parts.push("余额 读取失败");
			}
			if (estimate === null) {
				parts.push(cost === null ? "本会话预估 无用量" : `本会话预估 ${formatCostShort(cost.total, "¥")}`);
			} else {
				parts.push(`本会话预估 ${formatCostShort(estimate, "¥")}`);
			}
			// 把"按哪个模型的价算的"说清楚：这是错的来源，藏起来只会让人怀疑数字
			const modelLabel = modelInfo?.model;
			if (typeof modelLabel === "string" && modelLabel.length > 0) {
				const mixed = Array.isArray(modelInfo.modelsUsed) && modelInfo.modelsUsed.length > 1;
				parts.push(mixed ? `按 ${modelLabel} 计价（本会话混用过 ${modelInfo.modelsUsed.length} 个模型，为估算）` : `按 ${modelLabel} 计价`);
			}
			if (sessionId !== undefined) parts.push(`会话 ${sessionId.slice(0, 8)}`);
			return parts.join("，");
		}

		/**
		 * 右下角 HUD：余额 + 本会话花费。
		 *
		 * 数据来源两条：
		 * - 余额走 Host 只读路由 `/api/balance-hud/balance`（30 秒轮询 + 失败退避重试）；
		 * - 花费走会话 `tokenUsage` 投影，乘官方价格表得预估金额；同时用**持久化**
		 *   的余额基线给出「实际」口径。
		 *
		 * @param props - 注入的 ctx、活动会话 id、用量与余额读取器。
		 * @returns 常驻右下角的浮层。
		 */
		function BalanceHud(props) {
			const ctx = props.ctx;
			// 会话 id 双通道：框架标准 share `useSessions`（若宿主在根作用域提供了它）
			// 优先，取不到就回落到注册时 inject() 采到的快照。两条都不通时依然渲染
			// 余额，只是「本会话」显示为待命状态。
			const hookedSessionId = typeof props.useSessions === "function"
				? props.useSessions((state) => {
						const rows = Object.values(state?.byId ?? {});
						return rows.find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id;
					})
				: undefined;
			const sessionId = hookedSessionId ?? props.sessionId;
			const [usage, setUsage] = React.useState(undefined);
			const [usageError, setUsageError] = React.useState(undefined);
			const [balance, setBalance] = React.useState(undefined);
			// 交互状态合成一个 state（一次只改一处，hook 时序更稳）：
			// `hover` = 鼠标悬停展开明细，`collapsed` = 点击折叠成角标，`rev` = 手动刷新计数。
			const [ui, setUi] = React.useState({ hover: false, collapsed: false, rev: 0, refreshing: false });
			const { hover, collapsed, rev, refreshing } = ui;
			/**
			 * 「本会话预估」的递推基准：上一次拿到分摊值时的 (token 成本, 分摊值) 配对。
			 * 两次余额刷新之间用"新增 token 的预估花费"往前推，让数字平滑增长。
			 */
			const confirmedRef = React.useRef({ sessionId: undefined, ownTokens: undefined, apportioned: undefined });
			/** 已经见过的赠金 orderId：赠金接口不回执，靠它去重，避免反复提示。 */
			const seenBonuses = React.useRef(new Set());
			/**
			 * 「我刚充值了」的处理中状态：点下去先重锚（本地、瞬时），
			 * 再查一次官方赠金做印证；查询期间显示「查询中…」。
			 * 这样这个按钮的反馈是有实际工作支撑的，不是纯装饰。
			 */
			const [markingTopUp, setMarkingTopUp] = React.useState(false);
			/**
			 * 最近一次渲染时算出的分摊快照 (own=本会话 token 成本, all=全部会话 token 成本之和)。
			 * 余额刷新完成时用它落定递推基准，避免在 effect 里重算一遍导致口径不一致。
			 */
			const apportionedRef = React.useRef({ sessionId: undefined, own: undefined, model: undefined, peak: undefined });
			/** 识别到充值后的短暂提示（面板里显示一行，约 12 秒后自己消失）。 */
			const [topupNotice, setTopupNotice] = React.useState(null);
			/** 手动刷新计数：用于区分"用户点的刷新"与"自动轮询"。 */
			const refreshRequested = React.useRef(false);
			/** 最近一次成功读到余额的时间（用于显示t("justUpdated")）。 */
			const [lastSuccessAt, setLastSuccessAt] = React.useState(undefined);
			/** 配置：与设置里的那一行共享同一个容器，任一处保存两边立即同步。 */
			const settings = useSettings(props.settingsStore, React.useState, React.useEffect);
			/**
			 * 界面语言：设置里显式选了就用它，否则跟随 DSH。
			 *
			 * `dshLocaleId` 用 state 装是因为 DSH 换语言时要**立刻**重渲染 ——
			 * 订阅 `locale.subscribe` 才能做到（轮询/设置变化都不会触发这个）。
			 */
			const [dshLocaleId, setDshLocaleId] = React.useState(() => readDshLocaleId(ctx));
			React.useEffect(() => {
				setDshLocaleId(readDshLocaleId(ctx));
				return subscribeDshLocale(ctx, () => setDshLocaleId(readDshLocaleId(ctx)));
			}, [ctx]);
			const lang = resolveLang(settings.uiLanguage, dshLocaleId);
			/** 本次渲染的取词函数。 */
			const t = (key, vars) => translate(lang, key, vars);
			/**
			 * 配置的镜像 ref：轮询 effect 的闭包在挂载时就固定了，
			 * 读 ref 才能拿到"当前"间隔，否则改了设置要等下次重挂才生效。
			 */
			const settingsRef = React.useRef(settings);
			settingsRef.current = settings;
			/**
			 * 收起延时（ms）。卡片与面板是两个独立元素，指针从卡片移到面板时
			 * 会先触发卡片的 mouseleave；给它一点时间，让面板的 mouseenter
			 * 有机会取消这次收起，避免"往面板上移就消失"。
			 * 指针往上/往左离开任何一个元素时，没有后续 enter 来取消，延时到点即收起。
			 */
			const HOVER_CLOSE_MS = 140;
			const hoverCloseTimer = React.useRef(undefined);

			/** 指针进入卡片或面板：取消待收起，并确保展开。 */
			const hoverOn = () => {
				clearTimeout(hoverCloseTimer.current);
				hoverCloseTimer.current = undefined;
				setUi((state) => (state.hover ? state : { ...state, hover: true }));
			};
			/** 指针离开卡片或面板：延时收起（另一个元素的 enter 会取消它）。 */
			const hoverOff = () => {
				clearTimeout(hoverCloseTimer.current);
				hoverCloseTimer.current = setTimeout(() => {
					hoverCloseTimer.current = undefined;
					setUi((state) => (state.hover ? { ...state, hover: false } : state));
				}, HOVER_CLOSE_MS);
			};

			// 活动会话的 tokenUsage 投影：订阅式读取 + 兜底轮询，会话切换自动重挂。
			React.useEffect(() => {
				setUsage(undefined);
				setUsageError(undefined);
				if (sessionId === undefined) return undefined;
				const read = () => {
					try {
						const face = ctx.sessions?.binding?.(sessionId)?.session?.projections?.faceOf("tokenUsage");
						if (face === undefined) return undefined;
						setUsage(face.getSnapshot());
						setUsageError(undefined);
						return face;
					} catch (error) {
						setUsageError(String(error && error.message ? error.message : error));
						return undefined;
					}
				};
				const face = read();
				const unsubscribe = face?.subscribe?.(read);
				const timer = setInterval(read, 5000);
				return () => {
					clearInterval(timer);
					unsubscribe?.();
				};
			}, [ctx, sessionId, rev]);

			// 基线现在挂在**账户级**：锚点表由 apply 创建、通过 inject 以 props.baselineStage 传入，
			// 因为账户级计算发生在 inject 的闭包里（那里才拿得到 store）。
			const { baselineStage } = props;
			/**
			 * 锚点表的版本号。**store 是普通对象，改它不会触发重渲染** ——
			 * 而"哪些会话在分摊"正是渲染时读 store 得到的。少了这个版本号会出现：
			 * 分母只算到本会话 → 占比恒为 100% → 每个会话的预估值都等于账户级（看起来"都一样"）。
			 */
			const [epoch, setEpoch] = React.useState(0);
			// epoch 本身不参与计算，它的作用就是"强制再渲染一次"；此处读取以满足 lint
			void epoch;
			const bumpEpoch = () => setEpoch((value) => value + 1);
			// 充值提示自动消失（可观测性，但不占地方）
			React.useEffect(() => {
				if (topupNotice === null) return undefined;
				const timer = setTimeout(() => setTopupNotice(null), TOPUP_NOTICE_MS);
				return () => clearTimeout(timer);
			}, [topupNotice]);

			// 每分钟滴答一次：峰谷倒计时、预算显示与**跨天重置**都要跟着时间走。
			// 间隔固定 60 秒，且只在挂载期间存在，开销可忽略。
			const [, setClockTick] = React.useState(0);
			/** 今日累计花费（元）。跨天时自动归零。 */
			const [dailySpent, setDailySpent] = React.useState(() => loadDaily().total);
			React.useEffect(() => {
				const timer = setInterval(() => {
					setClockTick((value) => value + 1);
					// loadDaily 内部会处理跨天：日期变了就返回 0
					setDailySpent(loadDaily().total);
				}, 60000);
				return () => clearInterval(timer);
			}, []);

			/** 把当前会话登记进锚点表（已存在则只更新"最近访问"时间）。 */
			const registerActiveSession = (total) => {
				checkoutSession(sessionId, typeof total === "number" ? total : null);
			};
			React.useEffect(() => {
				baselineStage.store = readStore();
				registerActiveSession(baselineStage.runningBalance);
				baselineStage.activeSession = sessionId;
				// 登记完立刻让渲染重来一次，让 denominator（全会话 token）重新取数
				bumpEpoch();
				// sessionId / rev 变化时重新登记（rev 是手动刷新）
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [sessionId, rev]);

			// 余额：**订阅官方 account/watch 推送流**（设置 → 账号与余额 用的同一条通道），
			// 推送一到就重读余额。这样只有一个数据源：Host 查一次，设置页和 HUD 同时更新，
			// 余额：轮询 Host 只读路由。前台 60 秒一次，页面隐藏时降到 5 分钟一次，
			// 页面回到前台立刻补一次。失败按 1s→2s→5s→10s→20s 退避重试（仅在出错时）。
			React.useEffect(() => {
				let disposed = false;
				let timer;
				let attempt = 0;
				const schedule = (delay) => {
					if (disposed) return;
					clearTimeout(timer);
					timer = setTimeout(load, delay);
				};

				async function load() {
					let next;
					try {
						next = await readBalance();
					} catch (error) {
						next = { kind: "error", reason: `余额读取意外失败：${error && error.message ? error.message : String(error)}` };
					}
					if (disposed) return;
					setBalance(next);
					// 基线记账：**唯一的入口** —— observeRead 会判定这次读数是消费还是充值。
					if (next.kind === "ready") {
						baselineStage.runningBalance = next.total;
						baselineStage.activeSession = sessionId;
						registerActiveSession(next.total);
						// token 估算上界：期间全部会话的 token 预估花费之和（充值判据）
						const snapshot = apportionedRef.current;
						const others = Object.keys(baselineStage.store?.sessions ?? {})
							.filter((id) => id !== sessionId)
							.reduce((sum, id) => sum + (props.tokensOf?.(id, snapshot.model, snapshot.peak) ?? 0), 0);
						const bound = (snapshot.own ?? 0) + others;
						const verdict = observeRead(sessionId, next.total, bound);
						// 今日台账只吃**确认**的消费（不用递推显示值，否则同一笔钱会反复累加）
						if (verdict.kind === "spend" && verdict.amount > 0) {
							const today = addDailySpent(verdict.amount);
							setDailySpent(today);
						}
						baselineStage.store = verdict.store ?? readStore();
						// 识别到外部变动 → 给面板一条短暂提示（可观测性，否则完全是静默的）
						if (verdict.kind === "expire") {
							// 外部**减钱**：最典型的就是赠金到期被平台回收。
							// 只移动了锚点、没有加进花费，所以要明确告诉用户这块钱去哪了。
							setTopupNotice({ kind: "expire", amount: verdict.amount, at: Date.now() });
						} else if (verdict.kind === "topup") {
							setTopupNotice({ kind: "topup", amount: verdict.amount, at: Date.now() });
							// 印证（方案 B）：查官方未回执赠金，命中就记下 orderId 去重。
							// 这只是加分项 —— 判据主体是 token 估算上界，接口不通也照样识别。
							readBonuses()
								.then((bonuses) => {
									if (disposed || bonuses.length === 0) return;
									const fresh = bonuses.filter((item) => !seenBonuses.current.has(item.orderId));
									for (const item of fresh) seenBonuses.current.add(item.orderId);
									if (fresh.length > 0) {
										setTopupNotice({
											kind: "topup",
											amount: verdict.amount,
											at: Date.now(),
											bonus: fresh.reduce((sum, item) => sum + (item.amount || 0), 0),
											// 最早的到期时间：让用户提前知道哪笔赠金要用掉
											expiresAt: fresh
												.map((item) => item.expiresAt)
												.filter((value) => typeof value === "string" && value !== "")
												.sort()[0]
										});
									}
								})
								.catch(() => {});
						}
						// 落定递推基准：用**计数器的确认值** × token 占比
						if (snapshot.sessionId === sessionId && typeof snapshot.own === "number") {
							const accountNow = sessionSpentOf(baselineStage.store, sessionId);
							if (typeof accountNow === "number") {
								const allNow = snapshot.own + others;
								confirmedRef.current = {
									sessionId,
									ownTokens: snapshot.own,
									apportioned: allNow > 0 ? accountNow * (snapshot.own / allNow) : 0
								};
							}
						}
						// store 变了 → 触发重渲染，重新计算"全会话 token"这个分母
						bumpEpoch();
					}
					// 手动刷新的收尾：无论成功失败都要清掉t("refreshingShort")，否则按钮会一直转。
					if (refreshRequested.current) {
						refreshRequested.current = false;
						if (next.kind === "ready") setLastSuccessAt(Date.now());
						setUi((state) => (state.refreshing ? { ...state, refreshing: false } : state));
					} else if (next.kind === "ready") {
						setLastSuccessAt(Date.now());
					}
					if (next.kind === "ready") {
						attempt = 0;
						schedule(pollInterval(settingsRef.current));
						return;
					}
					// 未登录不是错误、也不该快重试；查询失败才退避重试。
					if (next.kind === "unavailable") {
						schedule(pollInterval(settingsRef.current));
						return;
					}
					schedule(BALANCE_RETRY_MS[Math.min(attempt, BALANCE_RETRY_MS.length - 1)]);
					attempt += 1;
				}

				// 页面回到前台时立刻补一次，并把间隔从"后台档"切回"前台档"。
				const onVisibility = () => {
					if (globalThis.document?.hidden === false) {
						clearTimeout(timer);
						load();
					}
				};
				try {
					globalThis.document?.addEventListener?.("visibilitychange", onVisibility);
				} catch {
					// 没有 document（非浏览器环境）时忽略。
				}

				load();
				return () => {
					disposed = true;
					clearTimeout(timer);
					try {
						globalThis.document?.removeEventListener?.("visibilitychange", onVisibility);
					} catch {
						// 同上
					}
				};
			// 依赖里必须带 sessionId：切换会话要**立刻**按新会话重读余额，
			// 否则最长 60 秒内显示的还是上一个会话的「实际扣费」，看起来像"没变"。
			}, [ctx, rev, sessionId, settings.pollSeconds, settings.hiddenPollSeconds]);

			const peak = isPeakHour(new Date());
			// —— 计价模型：默认跟随**会话实际用的模型** ——
			//
			// 原来只有全局下拉，会话中途换模型 / 不同会话用不同模型时必然算错。
			// 现在优先问 DSH 这个会话在用哪个模型（sessionModelOf），
			// 只在问不到时才回落到用户在设置里选的那个。
			//
			// 顺带拿到"这个会话一共用过哪些模型"：`tokenUsage` 是整会话聚合、没有模型维度，
			// 混用过多个模型时按单一模型计价只能是估算 —— 这一点会在界面上如实说明。
			const liveSession = (() => {
				try {
					return ctx.sessions?.binding?.(sessionId)?.session;
				} catch {
					return undefined;
				}
			})();
			const sessionModel = sessionModelOf(liveSession);
			const modelsUsed = sessionModelsUsed(liveSession);
			const followSession = settings.modelFollowsSession !== false;
			const model = followSession && sessionModel !== undefined ? sessionModel : settings.model;
			// 价格表：有同步结果就用同步的，否则内置表（见 resolvePrices）。
			// 直接读缓存（同步操作，开销可忽略）：同步发生在设置那一行，
			// 浮层与它没有共同的 React 祖先，读缓存是最直接的共享方式。
			const priceSource = resolvePrices(loadPriceCache());
			const prices = priceSource.prices;
			const cost = costOf(usage, model, peak, prices);
			// balance 的三态：undefined=尚未返回；kind=ready/unavailable/error。
			const ready = balance?.kind === "ready";
			const currency = ready ? balance.currency : "CNY";
			const symbol = currencySymbol(currency);

			// —— 三个口径 ——
			// sessionActual（=accountActual）：**本会话**锚点 − 当前余额。跟着会话走，单会话即真实扣费。
			// ownActual：并行时按 token 比例拆出本会话那一份；单会话时等于 sessionActual。
			// accountTotal：账户级合计（各会话累计计数之和），只作面板参照。
            //           余额不携带"谁花的"，所以单会话真实扣费在本进程内不可观测；用可精确计算的
            //           token 成本当权重（四类 token 分别计价 + 峰谷价，见 costOf）。
			// ownEstimate：卡片上展示的「本会话预估」—— 两次刷新之间按新增 token **递推**：
			//           上次刷新确认的分摊值 + 此后新增 token 的预估花费。
			//           刷新一到位就落定到新的分摊值，所以数字是小步增长而不是每 60 秒跳一次。
			// sessionSpent：**本会话累计花费**（计数器，充值不影响它）。
			// ownActual：并行时再按 token 成本占比拆出本会话那一份；单会话时占比恒为 1，等于全额。
			// accountTotal：账户级合计（各会话计数之和），只在并行时作面板参照。
			const accountActual = props.sessionSpent?.() ?? null;
			const accountTotal = props.accountTotal?.() ?? null;
			const trackedSessions = props.trackedSessions?.() ?? [];
			const ownTokens = cost?.total ?? 0;
			// 其它会话的成本必须用**同一套价格口径**（同模型、同峰谷）才算得出可比权重。
			// 成本本身仍按四类 token 分别计价：未命中输入 / 缓存命中 / 缓存写 / 输出（见 costOf）。
			const otherTokens = trackedSessions
				.filter((id) => id !== sessionId)
				.reduce((sum, id) => sum + (props.tokensOf?.(id, model, peak) ?? 0), 0);
			const allTokens = ownTokens + otherTokens;
			// 分母为 0（没有任何 token 成本）时分摊值是 0，而不是退回全额 ——
			// 那才是"没有可分摊的花费"的正确含义。
			const ownActual =
				typeof accountActual !== "number" ? accountActual : allTokens > 0 ? accountActual * (ownTokens / allTokens) : 0;
			// 并行标记：除了本会话还有别的会话在跟踪里 → 界面要说明这是分摊值
			const parallel = trackedSessions.filter((id) => id !== sessionId).length > 0;
			// 把本次渲染的分摊输入留给余额 effect：刷新完成时它要用**刚读到的 store**
			// 重算分母（那时渲染还没跑，拿不到新的 trackedSessions）。
			apportionedRef.current = { sessionId, own: ownTokens, model, peak };

			// 递推基准：**在余额刷新完成时**写入（不在渲染阶段改 ref，避免读到半新半旧的状态）。
			// 记录"那次刷新时的 (token 成本, 分摊值)"配对，两次刷新之间用它 + 新增 token 往前推。
			const confirmed = confirmedRef.current;
			const confirmedValid = confirmed.sessionId === sessionId && typeof confirmed.ownTokens === "number";
			const ownEstimate = confirmedValid
				? confirmed.apportioned + Math.max(0, ownTokens - confirmed.ownTokens)
				: typeof ownActual === "number"
					? ownActual
					: null;

			// —— 预算告警（A2）——
			// 用"当前该显示的花费"去比，而不是原始计数：并行分摊后它才是本会话的数字。
			const budgetSpent = typeof ownEstimate === "number" ? ownEstimate : (ownActual ?? null);
			const sessionBudgetState = evaluateBudget(budgetSpent, settings.sessionBudget);
			const dailyBudgetState = evaluateBudget(dailySpent, settings.dailyBudget);
			const budgetLevel = worstBudgetLevel([sessionBudgetState.level, dailyBudgetState.level]);
			const budgetColor = BUDGET_COLORS[budgetLevel];

			// —— 峰谷提醒（A3）——
			// 峰时价是闲时的正好两倍，所以"还有几分钟进入峰时"是实打实的省钱信息。
			const tier = minutesUntilTierChange(new Date());
			const peakWarning =
				settings.notifyPeak && tier.to === "peak" && tier.minutes <= settings.peakWarnMinutes
					? `约 ${tier.minutes} 分钟后进入峰时，价格翻倍`
					: null;
			// 已是峰时时给一条相反方向的提示：何时回到闲时。
			const offPeakHint =
				settings.notifyPeak && tier.to === "off" && tier.minutes <= settings.peakWarnMinutes
					? `约 ${tier.minutes} 分钟后回到闲时价`
					: null;

			/**
			 * 预算越级时发一条系统通知 —— 每个级别在本次挂载内只发一次，
			 * 否则每次读数都会弹，变成骚扰。
			 *
			 * 通知是**可选**的（设置里默认关）：浏览器要权限，拿不到就静默降级为
			 * 只有卡片描边变色，不影响其它功能。
			 */
			const notifiedLevels = React.useRef(new Set());
			React.useEffect(() => {
				if (budgetLevel === "none" || !settings.notifyBudget) return;
				if (notifiedLevels.current.has(budgetLevel)) return;
				notifiedLevels.current.add(budgetLevel);
				try {
					const api = globalThis.Notification;
					if (!api || api.permission !== "granted") return;
					const ratio = sessionBudgetState.level !== "none" ? sessionBudgetState.ratio : dailyBudgetState.ratio;
					new api(t("budgetNotifyTitle"), {
						body:
							budgetLevel === "over"
								? `花费已超出预算（${formatCostShort(budgetSpent ?? 0, "¥")}）`
								: `花费已达预算的 ${Math.round(ratio * 100)}%`
					});
				} catch {
					// 通知不可用就只保留视觉告警
				}
			}, [budgetLevel, settings.notifyBudget, budgetSpent, sessionBudgetState.ratio, sessionBudgetState.level, dailyBudgetState.ratio]);

			/**
			 * 手动兜底：用户点了「我刚充值了」。
			 *
			 * 两步：① 重锚到当前余额（本地、瞬时，只抬锚点不动计数）；
			 * ② 查一次官方赠金做印证（网络，可能慢）—— 这一步支撑「查询中…」的反馈。
			 * 无论查询成功、无赠金还是接口不通，都会收尾清掉「查询中…」。
			 */
			const onMarkTopUp = async () => {
				if (!ready || markingTopUp) return;
				setMarkingTopUp(true);
				const touched = props.markTopUp?.(balance.total);
				if (touched === false) {
					setMarkingTopUp(false);
					return;
				}
				bumpEpoch();
				// 印证：查官方未回执赠金。接口不通也不影响 —— 重锚已经生效。
				let bonus = 0;
				try {
					const bonuses = await readBonuses();
					const fresh = bonuses.filter((item) => !seenBonuses.current.has(item.orderId));
					for (const item of fresh) seenBonuses.current.add(item.orderId);
					bonus = fresh.reduce((sum, item) => sum + (item.amount || 0), 0);
				} catch {
					bonus = 0;
				}
				setTopupNotice({ kind: "topup", amount: null, at: Date.now(), bonus, manual: true });
				setMarkingTopUp(false);
			};

			const onRefresh = () => {
				// 立刻给出"正在刷新"的反馈，并在完成后显示t("justUpdated")。
				setUi((state) => (state.refreshing ? state : { ...state, refreshing: true }));
				refreshRequested.current = true;
				setUi((state) => ({ ...state, rev: state.rev + 1 }));
			};
			/** 悬停展开 / 移开收起。 */
			const setHover = (value) => setUi((state) => (state.hover === value ? state : { ...state, hover: value }));
			/** 点击切换折叠（折叠后只留一个角标，也不再悬停展开）。 */
			const toggleCollapsed = () => setUi((state) => ({ ...state, collapsed: !state.collapsed, hover: false }));

			/** 徽标上的余额文字：等待 / 未登录 / 失败 / 金额，绝不把失败显示成 0。 */
			const balanceText =
				balance === undefined
					? t("stateLoading")
					: ready
						? formatMoney(balance.total, symbol)
						: balance.kind === "unavailable"
							? t("stateSignedOut")
							: t("stateFailed");

			// 摘要文本只给无障碍用（aria-label），**不挂 `title`**：原生 tooltip 会在
			// 悬停约 1 秒后弹出一个黑框，和自绘的明细面板重复又打架。
			const summary = buildSummary(balance, cost, ownEstimate, sessionId, { model, modelsUsed });
			const detailOpen = hover;

			// 折叠态：只留一个角标，点击展开。
			if (collapsed) {
				return h(
					"div",
					{ style: rootStyle },
					h(
						"div",
						{
							style: collapsedCardStyle,
							role: "button",
							tabIndex: 0,
							"aria-expanded": false,
							"aria-label": `余额 ${balanceText}，已折叠，点击展开。${summary}`,
							onClick: toggleCollapsed,
							onKeyDown: (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									toggleCollapsed();
								}
							}
						},
						// 折叠态也是网格的一行：标签 + 数值两格。
						h("span", { style: gridLabelStyle }, t("panelAccountBalance")),
						h("span", { style: gridValueStyle }, balanceText)
					)
				);
			}

			const badge = h(
				"div",
				{
					// 预算告警靠左侧描边表达，而不是往网格里加格子 ——
					// 网格必须保持 2 列 × 2 行，多一格会破坏对齐（有回归断言钉着）。
					style: budgetColor
						? { ...cardStyle, borderLeft: `3px solid ${budgetColor}`, paddingLeft: "7px" }
						: cardStyle,
					// 卡片自身的进 / 出：进入即展开；离开则延时收起
					// （指针若正好移进面板，面板的 onMouseEnter 会取消这次收起）。
					onMouseEnter: hoverOn,
					onMouseLeave: hoverOff,
					role: "button",
					tabIndex: 0,
					"aria-expanded": detailOpen,
					"aria-label": `${summary}。悬停看明细，点击折叠`,
					onClick: toggleCollapsed,
					onKeyDown: (event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							toggleCollapsed();
						}
					}
				},
				// 两列网格，逐格摆放：第 1 行标签 / 第 1 行数值 / 第 2 行标签 …
				// 第 1 行：账户余额
				h("span", { style: gridLabelStyle }, t("panelAccountBalance")),
				h("span", { style: gridValueStyle }, balanceText),
				// 第 2 行：本会话预估花费（递推值：上次确认的分摊值 + 此后新增 token 的预估）
				// 没有用量时显示「—」，而不是 ¥0.00：没跑过就不该显示"花了 0 元"这种肯定陈述。
				h("span", { style: gridLabelStyle }, t("sessionEstimate")),
				h(
					"span",
					{ style: gridValueStyle },
					cost === null ? "—" : formatCostShort(ownEstimate === null ? cost.total : ownEstimate, symbol)
				)
			);

			const panel = detailOpen
				? h(
						"div",
						{
							style: panelStyle,
							// 面板自身的进 / 出：进入即取消收起（从卡片移过来时保住面板）；
							// 离开面板即延时收起 —— 于是"往左滑出面板左边"会收起，
							// 而不是被外层容器多出来的空白区域吃掉。
							onMouseEnter: hoverOn,
							onMouseLeave: hoverOff,
							role: "dialog",
							"aria-label": t("cardAriaLabel")
						},
						h(
							"div",
							{ style: { ...rowStyle, marginBottom: "6px" } },
							h(
								"span",
								{ style: { fontWeight: 600 } },
								t("panelAccountBalance"),
								// 最近一次成功读取的时间：给t("refresh")一个可见的凭据，
								// 否则点了按钮没有任何变化，看起来像没反应。
								typeof lastSuccessAt === "number"
									? h(
											"span",
											{ style: { ...labelStyle, fontWeight: 400, marginLeft: "6px" } },
											`更新于 ${formatClock(lastSuccessAt)}`
										)
									: null
							),
							h(
								"button",
								{
									type: "button",
									onClick: onRefresh,
									disabled: refreshing,
									"aria-busy": refreshing,
									style: {
										border: 0,
										background: "transparent",
										color: refreshing
											? "var(--dsw-alias-label-tertiary, #8a8a8f)"
											: "var(--dsw-alias-label-secondary, #5b5b60)",
										cursor: refreshing ? "default" : "pointer",
										fontSize: "11px",
										padding: 0
									}
								},
								refreshing ? t("refreshing") : t("refresh")
							),
							// 手动兜底（方案 C）：万一自动判错，点一下就纠正 —— 只抬锚点、不动计数。
							// 处理中的反馈和「刷新」同款：先重锚（瞬时），再查赠金印证（网络），
							// 查询期间显示「查询中…」。
							h(
								"button",
								{
									type: "button",
									onClick: onMarkTopUp,
									disabled: !ready || markingTopUp,
									"aria-busy": markingTopUp,
									style: {
										border: 0,
										background: "transparent",
										color:
											ready && !markingTopUp
												? "var(--dsw-alias-label-secondary, #5b5b60)"
												: "var(--dsw-alias-label-tertiary, #8a8a8f)",
										cursor: ready && !markingTopUp ? "pointer" : "default",
										fontSize: "11px",
										padding: 0,
										marginLeft: "8px"
									}
								},
								markingTopUp ? t("checking") : t("markTopUp")
							)
						),
						// 外部变动的短暂提示：只给可观测性，不中断任何计数。
						// 充值（余额被外部抬高）与过期回收（余额被外部扣减）都会提示，
						// 因为两者都**不计入花费**，不说一声用户会以为数字出错了。
						topupNotice !== null
							? h(
									"div",
									{ style: { ...hintStyle, color: "var(--dsw-alias-label-secondary, #5b5b60)" } },
									topupNotice.kind === "expire"
										? `检测到 ${formatCostShort(topupNotice.amount, symbol)} 非消费性扣减（赠金过期回收等），未计入花费。`
										: `${topupNotice.manual
												? t("topUpAnchored")
												: `已识别充值 ${formatCostShort(topupNotice.amount, symbol)}`}，花费继续累计${
												topupNotice.bonus ? `（官方赠金 ${formatCostShort(topupNotice.bonus, symbol)} 印证）` : ""
											}${topupNotice.expiresAt ? `，最早到期 ${topupNotice.expiresAt.slice(0, 10)}` : ""}。`
								)
							: null,
						// —— A3 峰谷提醒：进入峰时前预告，峰时中告知何时回闲时 ——
						peakWarning || offPeakHint
							? h(
									"div",
									{ style: { ...hintStyle, color: BUDGET_COLORS.warn } },
									peakWarning ? `⏰ ${peakWarning}` : `⏰ ${offPeakHint}`
								)
							: null,
						// —— A2 预算：只在设过预算时出现，按最严重的一条显示 ——
						// 关键点：**文案里的数字必须和判据同源**。
						// 每日预算的级别是按"今日台账"算的，就不能拿本会话的数字去显示，
						// 否则会出现"级别说超限、数字却没到"的自相矛盾。
						budgetLevel !== "none"
							? (() => {
									const useDaily =
										dailyBudgetState.level !== "none" &&
										(dailyBudgetState.level === "over" || sessionBudgetState.level === "none" || dailyBudgetState.ratio >= sessionBudgetState.ratio);
									const spentNow = useDaily ? dailySpent : (budgetSpent ?? 0);
									const limit = useDaily ? settings.dailyBudget : settings.sessionBudget;
									const remaining = useDaily ? dailyBudgetState.remaining : sessionBudgetState.remaining;
									const tierLabel =
										budgetLevel === "over" ? t("budgetOver") : budgetLevel === "critical" ? t("budgetCritical") : t("budgetWarn");
									return h(
										"div",
										{ style: { ...hintStyle, color: budgetColor } },
										`预算：${useDaily ? t("budgetDailyUsed") : t("budgetSessionUsed")} ${formatCostShort(spentNow, symbol)} / ${formatCostShort(limit, symbol)} —— ${tierLabel}${
											budgetLevel === "over" ? "" : `，还剩 ${formatCostShort(remaining ?? 0, symbol)}`
										}`
									);
								})()
							: null,
						!ready
							? h(React.Fragment, null,
									h(Row, {
										label: t("stateStatus"),
										value:
											balance === undefined
												? t("stateLoadingEllipsis")
												: balance.kind === "unavailable"
													? t("stateSignedOut")
													: t("stateFailed")
									}),
									balance?.reason ? h(Row, { label: t("stateReason"), value: balance.reason }) : null
								)
							: h(React.Fragment, null,
									// 标签统一四个字，数值列右对齐，整块看起来像一张对齐的小表格。
									h(Row, { label: t("balanceTopup"), value: formatMoney(balance.rechargeTotal, symbol) }),
									balance.bonusTotal > 0
										? h(Row, { label: t("balanceBonus"), value: formatMoney(balance.bonusTotal, symbol) })
										: null,
									h(Row, { label: t("balanceTotal"), value: formatMoney(balance.total, symbol) })
								),
						h("div", { style: { height: "8px" } }),
						h(
							"div",
							{ style: { ...rowStyle, marginBottom: "6px" } },
							h("span", { style: { fontWeight: 600 } }, t("panelSessionSpend")),
							h("span", { style: labelStyle }, cost === null ? "" : `${cost.tier === "peak" ? t("tierPeak") : t("tierOff")}价`)
						),
						cost === null
							? h(Row, { label: t("stateStatus"), value: usageError ?? t("panelNoUsage") })
							: h(React.Fragment, null,
									// 计价模型：说明"这个数按谁的价算的"，以及是不是估算。
									// 混用过多个模型时必须讲清楚 —— tokenUsage 是整会话聚合，
									// 没有模型维度，所以那种情况下只能按一个模型的价去估。
									h(Row, {
										label: t("panelPricedBy"),
										value:
											modelsUsed.length > 1
												? `${model}（混用 ${modelsUsed.length} 个，估算）`
												: model
									}),
									// 面板里的花费一律 4 位小数：token 量级的花费常不足 1 分，
									// 2 位会全是 0.00，看不出差别。
									// 「本会话预估」= 上次刷新确认的分摊值 + 此后新增 token 的预估（与卡片同源）
									h(Row, {
										label: t("sessionEstimate"),
										value:
											ownEstimate === null
												? formatCost(cost.total, "¥")
												: formatCost(ownEstimate, symbol)
									}),
									h(Row, { label: t("detailMiss"), value: formatCost(cost.miss, "¥") }),
									h(Row, { label: t("detailCacheHit"), value: formatCost(cost.hit, "¥") }),
									h(Row, { label: t("detailOutput"), value: formatCost(cost.output, "¥") }),
									// 累计花费：充值不影响它（只抬锚点），所以不再有"暂停"状态。
									h(Row, {
										label: parallel ? t("sessionApportioned") : t("actualSpend"),
										value: !ready
											? t("stateWaitingBalance")
											: typeof ownActual === "number"
												? formatCost(ownActual, symbol)
												: t("stateWaitingFirstRead")
									}),
									parallel && settings.showAccountTotal
										? h(Row, {
												label: t("accountTotal"),
												value:
													typeof accountTotal === "number"
														? formatCost(accountTotal, symbol)
														: "—"
											})
										: null,
									h(Row, {
										label: t("panelTokens"),
										value: `${formatTokens(cost.missTokens)} / ${formatTokens(cost.hitTokens)} / ${formatTokens(cost.outputTokens)}`
									}),
									// 分摊权重：只有这一个数决定t("sessionApportioned")占账户级的多少。
									// 并行时如果这里显示 100%，说明分母只算到了本会话 —— 那分摊值必然等于账户级。
									h(Row, {
										label: t("panelShare"),
										value: allTokens > 0 ? `${((ownTokens / allTokens) * 100).toFixed(1)}%` : "—"
									}),
									parallel
										? h(Row, {
												label: t("panelOtherSessions"),
												value: formatCost(otherTokens, "¥")
											})
										: null,
									parallel
										? h(Row, {
												label: t("panelTrackedSessions"),
												value: t("panelSessionCount", { n: trackedSessions.length })
											})
										: null
								),
						cost?.unknownModel
							? h("div", { style: hintStyle }, t("unknownModelNotice", { model, fallback: cost.usingPriceOf }))
							: null,
						h(
							"div",
							{ style: hintStyle },
							t("panelFootnote")
						)
					)
				: null;

			return h(
				"div",
				{ style: rootStyle },
				h(
					"div",
					{
						style: hoverSurfaceStyle
					},
					panel,
					badge
				)
			);
		}
		//#endregion

		//#region 余额基线（账户级）
		/** 基线持久化的 localStorage 键（v3 起带成员表）。 */
		const TRACKER_KEY = "dsh-balance-hud:tracker:v4";
		/** 旧键：读到就迁移。 */
		const LEGACY_KEYS = ["dsh-balance-hud:tracker:v3", "dsh-balance-hud:tracker:v2", "dsh-balance-hud:tracker:v1"];
		/** 余额跳增（充值 / 赠金到账）的判定阈值。 */
		const TOPUP_EPSILON = 0.01;
		/** 单条基线的最长保留时间：超过视为陈旧，重新定基。 */
		const TRACKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
		/** 最多保留多少个会话的基线（超出按时间淘汰最旧的）。 */
		const TRACKER_MAX_SESSIONS = 30;
		/** 保留多少条充值事件（用于面板展示与赠金去重）。 */
		const TRACKER_MAX_TOPUPS = 10;
		/**
		 * 判定"余额跳高算不算充值"的精度容差。
		 *
		 * 判据用的是 **token 估算上界**（平台扣的钱不可能超过这段时间 token 按价目表算出的钱），
		 * 所以这里只需要覆盖浮点与分位取整的噪声，不需要留大余量。
		 */
		const TOPUP_TOLERANCE = 0.02;
		/** 识别到充值后的提示停留时间。 */
		const TOPUP_NOTICE_MS = 12000;

		/**
		 * 读基线表：`{ sessions: { [id]: { baseline, lastBalance, spent, ts } } }`。
		 *
		 * 本函数只负责**把 JSON 读出来并做老格式迁移**，不参与任何记账计算；
		 * 账户级口径见下面的 `accountLevelDelta`（各会话 spent 之和）。
		 *
		 * 兼容 v3（`{ sessions: {…} }`）、v2（扁平字典）与 v1（单条记录）。
		 *
		 * @returns 基线表 `{ sessions }`。
		 */
		function readStore() {
			try {
				const raw = globalThis.localStorage?.getItem(TRACKER_KEY);
				if (raw !== null && raw !== undefined) {
					const parsed = JSON.parse(raw);
					if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
						if (parsed.sessions !== null && typeof parsed.sessions === "object") return parsed;
					}
				}
				// 迁移：v3 已经是 `{ sessions: {…} }`（旧版本的同名键），
				//       v2 是扁平的 `{ [sessionId]: {…} }`，v1 是单条 `{ sessionId, … }`
				for (const key of LEGACY_KEYS) {
					const legacyRaw = globalThis.localStorage?.getItem(key);
					if (legacyRaw === null || legacyRaw === undefined) continue;
					const legacy = JSON.parse(legacyRaw);
					if (legacy === null || typeof legacy !== "object") continue;
					let sessions = {};
					if (typeof legacy.sessionId === "string") {
						// v1：单条
						sessions = { [legacy.sessionId]: { baseline: legacy.baseline, start: legacy.start, ts: legacy.ts } };
					} else if (legacy.sessions !== null && typeof legacy.sessions === "object") {
						// v3：已经是 { sessions: … } 形状，直接拿（保留 spent 等字段）
						sessions = Object.fromEntries(
							Object.entries(legacy.sessions).filter(([, entry]) => typeof entry?.ts === "number")
						);
					} else {
						// v2：扁平字典
						sessions = Object.fromEntries(
							Object.entries(legacy).filter(([, entry]) => typeof entry?.ts === "number")
						);
					}
					if (Object.keys(sessions).length > 0) {
						// 旧的 start 字段在计数器模型里没用了，顺手清掉
						for (const entry of Object.values(sessions)) delete entry.start;
						const migrated = { sessions, topups: Array.isArray(legacy.topups) ? legacy.topups : [] };
						globalThis.localStorage?.removeItem?.(key);
						writeStore(migrated);
						return migrated;
					}
				}
				return { sessions: {} };
			} catch {
				return { sessions: {} };
			}
		}

		/**
		 * 写回基线表（先淘汰过期与超量的记录）。
		 * @param store - 基线表。
		 */
		function writeStore(store) {
			try {
				const now = Date.now();
				const fresh = Object.entries(store.sessions ?? {})
					.filter(([, entry]) => typeof entry?.ts === "number" && now - entry.ts <= TRACKER_MAX_AGE_MS)
					.sort(([, a], [, b]) => b.ts - a.ts)
					.slice(0, TRACKER_MAX_SESSIONS);
				globalThis.localStorage?.setItem(TRACKER_KEY, JSON.stringify({ sessions: Object.fromEntries(fresh) }));
			} catch {
				// localStorage 不可用（隐私模式等）时降级为仅内存，功能不受影响。
			}
		}

		/**
		 * 新建一份基线状态。
		 *
		 * **必须无损**：`readStore()` 与 `loadTracker()` 返回的记录形状要一致，
		 * 否则新增字段会在"读—改—写"之间被静默丢掉。
		 * （曾经因为这里只映射了部分字段，`lastRead` 读不出来，
		 * 于是 `previousBalanceOf` 退化成用事件余额，把真实消费整段吞掉。）
		 *
		 * 字段含义：
		 * - `baseline`：该会话窗口起点的**账户余额**（重锚时会被移动）；
		 * - `lastBalance`：最近一次外部变动后的余额（账户级）；
		 * - `lastRead`：本会话**真正观测到**的余额，下次读数从它继续算；
		 * - `spent`：累计花费计数器，只增不减；
		 * - `ts`：最后一次更新的时间（用于淘汰）。
		 *
		 * @param sessionId - 归属会话。
		 * @param persisted - 从磁盘读回的那一条。
		 * @param ts - 该条的持久化时间。
		 * @returns 记录对象（形状与持久化一致）。
		 */
		function createTracker(sessionId, persisted, ts) {
			const record = { ...(persisted ?? {}) };
			record.sessionId = sessionId;
			if (typeof record.baseline !== "number") record.baseline = undefined;
			if (typeof record.spent !== "number") record.spent = 0;
			record.ts = ts ?? record.ts ?? Date.now();
			return record;
		}

		/**
		 * 取出某个会话的基线（没有则是空基线）。读不出来时返回 null。
		 * @param sessionId - 会话 id。
		 * @returns 基线对象或 null。
		 */
		function loadTracker(sessionId) {
			if (typeof sessionId !== "string") return null;
			const entry = readStore().sessions?.[sessionId];
			if (entry === undefined) return null;
			return createTracker(sessionId, entry, entry.ts);
		}

		/**
		 * 把某个会话的记录合并回磁盘（只动这一条，其它会话原样保留）。
		 *
		 * **必须无损**：以磁盘上已有的那条为基底，只覆盖调用方明确给出的字段。
		 * 早期版本用固定字段列表重建整条记录，于是 `checkoutSession`（每次切换会话都会走）
		 * 会把 `lastRead` 抹掉、还会把 `lastBalance` 写成 `undefined`（JSON 序列化时直接消失），
		 * 导致下次读数退化成用锚点当"上次读数"。
		 *
		 * @param tracker - 记录对象（只读取其中存在的字段）。
		 */
		function persistTracker(tracker) {
			if (typeof tracker.sessionId !== "string" || tracker.baseline === undefined) return;
			const store = readStore();
			store.sessions = store.sessions ?? {};
			const merged = { ...(store.sessions[tracker.sessionId] ?? {}) };
			merged.baseline = tracker.baseline;
			if (typeof tracker.spent === "number") merged.spent = tracker.spent;
			else if (typeof merged.spent !== "number") merged.spent = 0;
			merged.ts = tracker.ts ?? merged.ts ?? Date.now();
			// 只在调用方确实持有数值时才覆盖，绝不把已有的值抹成 undefined
			// （undefined 会在 JSON.stringify 时直接消失，等于静默删字段）
			if (typeof tracker.lastRead === "number") merged.lastRead = tracker.lastRead;
			if (typeof tracker.lastBalance === "number") merged.lastBalance = tracker.lastBalance;
			if (typeof tracker.last === "number") merged.lastBalance = tracker.last;
			store.sessions[tracker.sessionId] = merged;
			writeStore(store);
		}

		/**
		 * 记录"某会话被访问过"并抓取它的锚点。
		 *
		 * 首次访问时 `total` 为 null（进程刚起来还没读过余额），此时只登记会话，
		 * 锚点留到第一次读数时再定。
		 *
		 * @param sessionId - 被访问的会话。
		 * @param total - 当前账户余额；尚未读到则传 null。
		 */
		function checkoutSession(sessionId, total) {
			if (typeof sessionId !== "string") return;
			const existing = loadTracker(sessionId);
			if (existing === null) {
				const fresh = createTracker(sessionId, undefined, undefined);
				if (typeof total === "number") {
					fresh.baseline = total;
					fresh.last = total;
				}
				fresh.ts = Date.now();
				persistTracker(fresh);
				return;
			}
			existing.ts = Date.now();
			persistTracker(existing);
		}

		/**
		 * 判定一次余额读数该怎么记账。
		 *
		 * 唯一的判据是 **token 估算上界**，而且它**双向都成立**：平台扣掉的钱
		 * 不可能超过这段时间全部 token 按官方价目表算出来的钱（tokenEstimate）；
		 * 反过来，余额**减少**的量如果超过这个上界，多出来的部分也不可能来自消费。
		 *
		 * ```
		 * 余额升幅 > 上界  →  外部加钱：充值 / 赠金到账 / 账单修正      （topup）
		 * 余额降幅 > 上界  →  外部减钱：赠金过期回收 / 退款 / 账单修正  （expire）
		 * 其余             →  普通消费累计 / 忽略噪声
		 * ```
		 *
		 * 反向那条（`expire`）是**赠金时效性**必需的处理：赠金到期会被平台收回，
		 * 表现为余额凭空下降却没有对应消费。不区分的话这块钱会被记成t("panelSessionSpend")，
		 * 而且因为计数器只增不减，错误会一直留在里面。
		 *
		 * 比"拍一个 epsilon"可靠得多：两个方向都不会因为正常波动误判。
		 *
		 * @param previousBalance - 上一次读到的余额（可能是别的会话读的）。
		 * @param balance - 本次余额。
		 * @param tokenEstimate - 期间全部会话的 token 预估花费（保守上界）。
		 * @returns `{ kind, amount }`：kind 为 spend / topup / expire / flat / noise。
		 */
		function classifyRead(previousBalance, balance, tokenEstimate) {
			if (typeof previousBalance !== "number") return { kind: "flat", amount: 0 };
			const delta = balance - previousBalance;
			if (Math.abs(delta) <= 0.0001) return { kind: "noise", amount: 0 };
			const bound = (typeof tokenEstimate === "number" ? tokenEstimate : 0) + TOPUP_TOLERANCE;
			if (delta > 0) return delta > bound ? { kind: "topup", amount: delta } : { kind: "noise", amount: 0 };
			const drop = -delta;
			// 降幅超过上界 → 超出部分是外部减钱（最常见的是赠金过期）
			return drop > bound ? { kind: "expire", amount: drop } : { kind: "spend", amount: drop };
		}

		/**
		/**
		 * 判定一次读数该和**哪个余额**相比。
		 *
		 * 唯一的首选是 `lastRead` —— **本会话上次真正观测到的余额**。
		 * 这一点很关键：外部变动（充值到账 / 赠金过期回收）会改写 `baseline` 与
		 * `lastBalance`（它们是账户级、被事件驱动的），但**绝不会**动 `lastRead`。
		 *
		 * 于是每个会话都天然自愈：
		 * - 别的会话观测到的变动，本会话下次读数仍会看到完整落差，
		 *   于是它自己也能判出这是外部变动，而不会把差额当成消费；
		 * - 本会话自己触发的变动，因为那次读数已经处理过，起点自然推进，不会重复计入。
		 *
		 * 早期版本在这里加过一个"重锚桥"字段来补"变动前未观测的消费"，
		 * 但那个字段同时承担"上次读数"和"事件余额"两种含义，反复出错。
		 * `lastRead` 单独承载一种含义就够了。
		 *
		 * @param entry - 该会话的记录。
		 * @param store - 基线表（迁移过来的老数据可能缺 `lastRead`）。
		 * @returns 上次余额；完全没有可用值时返回 undefined。
		 */
		function previousBalanceOf(entry, store) {
			if (typeof entry.lastRead === "number") return entry.lastRead;
			// 老数据只有事件余额或锚点
			if (typeof entry.lastBalance === "number") return entry.lastBalance;
			if (typeof entry.baseline === "number") return entry.baseline;
			if (typeof store.lastObservedBalance === "number") return store.lastObservedBalance;
			return undefined;
		}

		/**
		 * 给**所有**会话重锚到当前余额 —— **充值到账**与**外部扣减**共用。
		 *
		 * 方向无关：外部变动只改余额、不改花费，所以这里只移动 `baseline` 与
		 * `lastBalance`（两个账户级字段），`spent` 一律原样保留。
		 *
		 * **刻意不动 `lastRead`**：它是"本会话上次真正观测到的余额"，属于会话私有。
		 * 让别的会话下次读数时仍能看到完整落差，从而各自独立地判出这是一次外部变动 ——
		 * 否则它们会把那段差额当成自己的消费。
		 *
		 * @param balance - 变动后的余额。
		 * @param amount - 识别到的变动金额（用于提示）。
		 * @param sessionId - 触发的会话。
		 * @param kind - `topup` 或 `expire`。
		 * @returns 更新后的基线表。
		 */
		function applyExternalChange(balance, amount, sessionId, kind) {
			const store = readStore();
			store.sessions = store.sessions ?? {};
			const now = Date.now();
			for (const entry of Object.values(store.sessions)) {
				entry.baseline = balance;
				entry.lastBalance = balance;
				entry.ts = now;
			}
			store.topups = [{ at: now, amount, sessionId, kind }, ...(store.topups ?? [])].slice(0, TRACKER_MAX_TOPUPS);
			writeStore(store);
			return store;
		}

		/**
		 * 记录一次余额读数并维护计数。
		 *
		 * **核心模型**：余额会因充值跳高，但花费计数**只增不减**。
		 * - 余额下降 → `spent += 降幅`（正常消费）
		 * - 判定为充值 → 只把锚点抬到当前余额，`spent` 不动，继续正常累计
		 *
		 * 于是"充值"从"停摆事件"变成"一次无副作用的重锚"，花费全程正常运行。
		 *
		 * @param sessionId - 读数所属会话。
		 * @param balance - 本次余额。
		 * @param tokenEstimate - 期间全部会话的 token 预估花费（判据上界）。
		 * @returns `{ kind, amount, spent }`：kind 为 spend / topup / flat / noise。
		 */
		function observeRead(sessionId, balance, tokenEstimate) {
			if (typeof sessionId !== "string" || typeof balance !== "number") {
				return { kind: "flat", amount: 0, spent: 0 };
			}
			const store = readStore();
			store.sessions = store.sessions ?? {};
			let entry = store.sessions[sessionId];
			if (entry === undefined) {
				entry = { baseline: balance, lastBalance: balance, lastRead: balance, spent: 0, ts: Date.now() };
				store.sessions[sessionId] = entry;
				writeStore(store);
				return { kind: "flat", amount: 0, spent: 0, store };
			}
			// 上一次读到的余额：本会话自己的 `lastRead`（见 previousBalanceOf）。
			const previous = previousBalanceOf(entry, store);
			const verdict = classifyRead(typeof previous === "number" ? previous : balance, balance, tokenEstimate);
			if (verdict.kind === "topup" || verdict.kind === "expire") {
				// 外部变动（充值到账 / 赠金过期回收）：只移动账户级字段、不动计数。
				// 触发会话自己的 `lastRead` 也在下面推进，所以这次变动不会被重复计入。
				const storeAfter = applyExternalChange(balance, verdict.amount, sessionId, verdict.kind);
				storeAfter.lastObservedBalance = balance;
				const mine = storeAfter.sessions?.[sessionId];
				if (mine) {
					mine.lastRead = balance;
					writeStore(storeAfter);
				}
				return {
					kind: verdict.kind,
					amount: verdict.amount,
					spent: storeAfter.sessions?.[sessionId]?.spent ?? 0,
					store: storeAfter
				};
			}
			if (verdict.kind === "spend") {
				entry.spent = (typeof entry.spent === "number" ? entry.spent : 0) + verdict.amount;
			}
			// 本会话追平到当前余额：推进 `lastRead`，下次从它继续算
			entry.lastRead = balance;
			entry.lastBalance = balance;
			entry.ts = Date.now();
			store.lastObservedBalance = balance;
			writeStore(store);
			return { kind: verdict.kind, amount: verdict.amount, spent: entry.spent, store };
		}

		/**
		 * **本会话**的累计花费：只由"余额下降"累加，充值不会改变它。
		 *
		 * 为什么不能直接用"锚点 − 当前余额"：那样充值会把数字压成 0 或负数，
		 * 只有等消费重新跌到锚点以下才恢复 —— 也就是之前的"充值后暂停"。
		 * 累计计数器没有这个问题：充值只抬锚点，计数照常。
		 *
		 * @param store - 基线表。
		 * @param sessionId - 当前会话。
		 * @returns 金额 / null（还没定锚）。
		 */
		function sessionSpentOf(store, sessionId) {
			const entry = store.sessions?.[sessionId];
			if (entry === undefined || typeof entry.baseline !== "number") return null;
			return typeof entry.spent === "number" ? entry.spent : 0;
		}

		/**
		 * 账户级累计花费：所有已跟踪会话 `spent` 之和。
		 * 仅用于面板参照；卡片不能用它当作t("panelSessionSpend")（会污染成同一个数）。
		 *
		 * @param store - 基线表。
		 * @returns 金额 / null（还没有任何会话定锚）。
		 */
		function accountLevelDelta(store) {
			const entries = Object.values(store.sessions ?? {});
			if (entries.length === 0) return null;
			return entries.reduce((total, entry) => total + (typeof entry?.spent === "number" ? entry.spent : 0), 0);
		}

		//#endregion
		//#region 设置里的那一行
		/**
		 * 设置行里的控件样式。
		 *
		 * **只用 DSH 主题契约里真实存在的 token**（theme 服务 `listTokens` 列出的那批）。
		 * 之前这里用了 `--dsw-alias-bg-elevated` 这种**不存在的名字**：
		 * CSS 变量取不到值就回退到 `transparent`，下拉框于是用了浏览器默认的**白底**，
		 * 而文字色取的是主题前景色（深色主题下是白的）—— 白底白字，看不见。
		 *
		 * 教训：宁可回退到"跟随父元素"（`inherit`），也不要用想当然的变量名指定背景。
		 */
		const settingLabelStyle = {
			display: "block",
			fontSize: "12px",
			color: "var(--dsw-alias-label-secondary, #8a8a8f)",
			marginBottom: "2px"
		};
		const settingSelectStyle = {
			font: "inherit",
			fontSize: "13px",
			padding: "3px 6px",
			borderRadius: "6px",
			// border-l1 / bg-layer-1 是契约里的真名
			border: "1px solid var(--dsw-alias-border-l1, currentColor)",
			background: "var(--dsw-alias-bg-layer-1, inherit)",
			color: "var(--dsw-alias-label-primary, inherit)"
		};
		const settingInputStyle = { ...settingSelectStyle, width: "90px" };
		/** 设置行里的小按钮（同步价格等）。 */
		const settingButtonStyle = { ...settingSelectStyle, cursor: "pointer", fontSize: "12px" };

		/**
		 * 设置 → 通用 里的「余额 HUD」偏好行。
		 *
		 * 注册在 `settings.general.item`：那个槽位就是为"一个插件自己的偏好"准备的，
		 * 不需要单独占一整页设置。
		 *
		 * 这一行读写的是**同一个配置容器**，所以在这里改模型/间隔，浮层立刻跟着变，
		 * 反之亦然。
		 *
		 * @param props - 注入的 `settingsStore`。
		 * @returns 一行偏好控件。
		 */
		function BalanceHudSettingsRow(props) {
			const React = require("react");
			const settings = useSettings(props.settingsStore, React.useState, React.useEffect);
			const update = (patch) => props.settingsStore.set(patch);

			// 界面语言：与 HUD 用同一套解析逻辑（显式设置 > DSH 当前语言 > 中文）
			const [dshLocaleId, setDshLocaleId] = React.useState(() => readDshLocaleId(ctx));
			React.useEffect(() => {
				setDshLocaleId(readDshLocaleId(ctx));
				return subscribeDshLocale(ctx, () => setDshLocaleId(readDshLocaleId(ctx)));
			}, [ctx]);
			const lang = resolveLang(settings.uiLanguage, dshLocaleId);
			const t = (key, vars) => translate(lang, key, vars);

			// 价格同步状态：只在**用户自己**点过按钮或选过间隔之后才会联网。
			const [syncState, setSyncState] = React.useState({ busy: false, message: "" });
			const [priceCache, setPriceCache] = React.useState(() => loadPriceCache());
			// DSH 注册的模型目录（走本机回环，不联网）——用来填充计价模型下拉
			const [modelChoices, setModelChoices] = React.useState(MODEL_CHOICES);

			React.useEffect(() => {
				let cancelled = false;
				readModels().then((catalog) => {
					if (cancelled) return;
					const ids = [];
					for (const list of Object.values(catalog.models ?? {})) {
						for (const item of list ?? []) {
							const id = typeof item === "string" ? item : item?.id;
							if (typeof id === "string" && id.length > 0 && !ids.includes(id)) ids.push(id);
						}
					}
					if (ids.length > 0) setModelChoices(ids);
				});
				return () => {
					cancelled = true;
				};
			}, []);

			/** 手动同步一次价格（**唯一会外联的用户动作之一**）。 */
			const onSyncNow = async () => {
				if (syncState.busy) return;
				setSyncState({ busy: true, message: t("checking") });
				const result = await syncPrices();
				setPriceCache(loadPriceCache());
				if (result.kind === "notModified") {
					setSyncState({ busy: false, message: t("settingsSyncUnchanged") });
				} else if (result.kind === "ok") {
					const count = Object.keys(result.models ?? {}).length;
					setSyncState({ busy: false, message: t("settingsSyncUpdated", { n: count }) });
				} else {
					setSyncState({ busy: false, message: result.reason ?? t("settingsSyncFailed") });
				}
			};

			// 自动同步：**必须用户显式选过间隔**才会启动。
			// 没选过（`syncHours === 0`）时这里什么都不做 —— 默认零外联。
			React.useEffect(() => {
				const hours = settings.syncHours ?? 0;
				if (!(hours > 0)) return undefined;
				const timer = setInterval(
					() => {
						syncPrices().then(() => setPriceCache(loadPriceCache()));
					},
					hours * 3600 * 1000
				);
				return () => clearInterval(timer);
			}, [settings.syncHours]);

			/** 价格来源文案：内置表还是已同步，各是哪天的。 */
			const priceSource = (() => {
				const resolved = resolvePrices(priceCache);
				if (resolved.source === "synced") {
					const day = typeof priceCache?.capturedAt === "string" ? priceCache.capturedAt.slice(0, 10) : "—";
					return t("settingsPriceSynced", { date: day });
				}
				return t("settingsPriceBuiltin", { date: BUILTIN_PRICES_DATE });
			})();

			/** 一个带标签的下拉。 */
			const Select = ({ label, value, options, onChange }) =>
				React.createElement(
					"label",
					{ style: { display: "inline-flex", flexDirection: "column", marginRight: "16px" } },
					React.createElement("span", { style: settingLabelStyle }, label),
					React.createElement(
						"select",
						{ style: settingSelectStyle, value: String(value), onChange: (event) => onChange(event.target.value) },
						options.map((option) =>
							React.createElement("option", { key: String(option.value), value: String(option.value) }, option.label)
						)
					)
				);

			/** 一个带标签的数字输入（预算）。 */
			const Money = ({ label, value, onChange }) =>
				React.createElement(
					"label",
					{ style: { display: "inline-flex", flexDirection: "column", marginRight: "16px" } },
					React.createElement("span", { style: settingLabelStyle }, label),
					React.createElement("input", {
						style: settingInputStyle,
						type: "number",
						min: "0",
						step: "1",
						value: String(value),
						placeholder: t("settingsBudgetPlaceholder"),
						onChange: (event) => onChange(Number(event.target.value))
					})
				);

			/** 一个勾选框。 */
			const Toggle = ({ label, checked, onChange }) =>
				React.createElement(
					"label",
					{ style: { display: "inline-flex", alignItems: "center", gap: "6px", marginRight: "16px", fontSize: "13px" } },
					React.createElement("input", {
						type: "checkbox",
						checked: Boolean(checked),
						onChange: (event) => onChange(event.target.checked)
					}),
					React.createElement("span", null, label)
				);

			return React.createElement(
				"div",
				{ style: { padding: "10px 0", display: "flex", flexDirection: "column", gap: "10px" } },
				React.createElement(
					"div",
					{ style: { fontSize: "13px", fontWeight: 600 } },
					t("settingsTitle"),
					React.createElement(
						"span",
						{ style: { ...settingLabelStyle, display: "inline", marginLeft: "8px", fontWeight: 400 } },
						t("settingsSubtitle")
					)
				),
				React.createElement(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", rowGap: "8px" } },
					React.createElement(Select, {
						label: t("panelPricedBy"),
						value: settings.model,
						options: modelChoices.map((id) => ({ value: id, label: id })),
						onChange: (value) => update({ model: value })
					}),
					React.createElement(Select, {
						label: t("settingsPoll"),
						value: settings.pollSeconds,
						options: POLL_CHOICES.map((seconds) => ({ value: seconds, label: `${seconds} 秒` })),
						onChange: (value) => update({ pollSeconds: Number(value) })
					}),
					React.createElement(Select, {
						label: t("settingsHiddenPoll"),
						value: settings.hiddenPollSeconds,
						options: POLL_CHOICES.map((seconds) => ({ value: seconds, label: `${seconds} 秒` })),
						onChange: (value) => update({ hiddenPollSeconds: Number(value) })
					}),
					React.createElement(Select, {
						label: t("settingsPeakLead"),
						value: settings.peakWarnMinutes,
						options: PEAK_WARN_CHOICES.map((m) => ({ value: m, label: `提前 ${m} 分钟` })),
						onChange: (value) => update({ peakWarnMinutes: Number(value) })
					})
				),
				React.createElement(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", rowGap: "8px" } },
					React.createElement(Money, {
						label: t("settingsSessionBudget"),
						value: settings.sessionBudget,
						onChange: (value) => update({ sessionBudget: value })
					}),
					React.createElement(Money, {
						label: t("settingsDailyBudget"),
						value: settings.dailyBudget,
						onChange: (value) => update({ dailyBudget: value })
					})
				),
				React.createElement(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", rowGap: "8px", alignItems: "flex-end" } },
					React.createElement(Select, {
						label: t("settingsLanguage"),
						value: settings.uiLanguage ?? "auto",
						options: [
							{ value: "auto", label: t("settingsLanguageAuto") },
							{ value: "zh", label: t("settingsLanguageZh") },
							{ value: "en", label: t("settingsLanguageEn") }
						],
						onChange: (value) => update({ uiLanguage: value })
					}),
					React.createElement(
						"span",
						{ style: { ...settingLabelStyle, marginBottom: "6px" } },
						// 把"DSH 现在是什么语言"显示出来：一来用户看得见生效依据，
						// 二来万一内置 locale 的 id 拼写和我预期不同，这里能立刻看出来。
						t("settingsLanguageResolved", {
							label: `${lang}${dshLocaleId === undefined ? "" : ` / DSH: ${dshLocaleId}`}`
						})
					)
				),
				React.createElement(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", rowGap: "8px", alignItems: "center" } },
					React.createElement(Toggle, {
						label: t("settingsShowAccountTotal"),
						checked: settings.showAccountTotal,
						onChange: (value) => update({ showAccountTotal: value })
					}),
					React.createElement(Toggle, {
						label: t("settingsNotifyPeak"),
						checked: settings.notifyPeak,
						onChange: (value) => update({ notifyPeak: value })
					}),
					React.createElement(Toggle, {
						label: t("settingsNotifyBudget"),
						checked: settings.notifyBudget,
						onChange: (value) => update({ notifyBudget: value })
					}),
					React.createElement(Toggle, {
						label: t("settingsModelFollow"),
						checked: settings.modelFollowsSession !== false,
						onChange: (value) => update({ modelFollowsSession: value })
					})
				),
				React.createElement(
					"div",
					{ style: { ...settingLabelStyle, marginBottom: 0 } },
					t("settingsModelFollowHint")
				),
				// —— 价格同步：唯一会外联的部分，默认完全不动 ——
				React.createElement(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", rowGap: "8px", alignItems: "flex-end" } },
					React.createElement(Select, {
						label: t("settingsSync"),
						value: settings.syncHours ?? 0,
						options: SYNC_INTERVAL_HOURS.map((hours) => ({
							value: hours,
							label: hours === 0 ? t("settingsSyncManual") : hours >= 24 ? t("settingsSyncEveryDays", { n: hours / 24 }) : t("settingsSyncEveryHours", { n: hours })
						})),
						onChange: (value) => update({ syncHours: Number(value) })
					}),
					React.createElement(
						"button",
						{
							type: "button",
							style: { ...settingButtonStyle, marginRight: "16px" },
							disabled: syncState.busy,
							onClick: onSyncNow
						},
						syncState.busy ? t("checking") : t("settingsSyncNow")
					),
					React.createElement(
						"span",
						{ style: { ...settingLabelStyle, marginBottom: "6px" } },
						`${t("settingsPriceSource")}：${priceSource}`
					)
				),
				syncState.message
					? React.createElement("div", { style: { ...settingLabelStyle, marginBottom: 0 } }, syncState.message)
					: null,
				React.createElement(
					"div",
					{ style: { ...settingLabelStyle, marginBottom: 0 } },
					t("settingsFootnote")
				),
				React.createElement(
					"div",
					{ style: { ...settingLabelStyle, marginBottom: 0 } },
					t("settingsPrivacyFootnote")
				)
			);
		}
		//#endregion

		//#region 插件体
		/** 依赖的客户端服务：槽位注册与会话 binding。余额走 Host 只读路由，不用 ctx.remote。 */
		const inject = ["slots", "sessions"];
		/**
		 * 注册右下角 HUD。
		 *
		 * 用 `shell.overlay`（框架级浮层，层级在所有列之上、且不受各列滚动容器
		 * 裁剪），组件自己用 `position: fixed` 钉在右下角。
		 *
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			const sessionHook = ctx.slots.hooks?.sessions;
			const activeSessionId = () => {
				try {
					if (typeof sessionHook !== "function") return undefined;
					const rows = Object.values(sessionHook.getSnapshot?.()?.byId ?? {});
					return rows.find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id;
				} catch {
					return undefined;
				}
			};

			// 账户级基线状态：锚点表 + 最近余额 + 当前会话。
			const baselineStage = { store: { sessions: {} }, runningBalance: null, activeSession: undefined };
			/**
			 * 配置容器：**设置里的那一行**与**浮层**共享同一个实例。
			 * 它们没有共同的 React 祖先，只能靠这个容器对齐；任一处保存，两边都刷新。
			 */
			const settingsStore = createSettingsStore();

			// 设置 → 通用 里的偏好行（`settings.general.item` 就是为"单个偏好"准备的座位）。
			// 用 inject 等待声明：主面板还没挂载时不会白注册。
			ctx.effect(
				() =>
					ctx.slots.inject("settings.general.item", () =>
						ctx.slots.register(
							{
								name: "settings.general.item",
								id: "balance-hud-settings",
								order: 500,
								inject: () => ({ settingsStore })
							},
							BalanceHudSettingsRow
						)
					),
				"balance-hud: 设置里的偏好行"
			);

			ctx.effect(
				() =>
					ctx.slots.inject("shell.overlay", () =>
						ctx.slots.register(
							{
								name: "shell.overlay",
								id: "balance-hud",
								order: 500,
								inject: () => ({
									ctx,
									sessionId: activeSessionId(),
									settingsStore,
									baselineStage,
									/**
									 * 本会话累计花费：只由"余额下降"累加。**充值不会改变它**
									 * （识别到充值只抬锚点，计数照常），所以不会再出现"充值后暂停"。
									 *
									 * @returns 金额 / null（该会话还没定锚）。
									 */
									sessionSpent: () => sessionSpentOf(baselineStage.store, baselineStage.activeSession),
									/** 账户级合计（各会话计数之和），仅作面板参照。 */
									accountTotal: () => accountLevelDelta(baselineStage.store),
									/** 已跟踪的会话（含各会话基线），供分摊时枚举。 */
									trackedSessions: () => Object.keys(baselineStage.store?.sessions ?? {}),
									/**
									 * 读某个会话的 token 成本（预估花费），作为分摊权重的一部分。
									 *
									 * **必须传模型与峰谷**：分母里的其它会话要和被分摊的会话**同一套价格口径**，
									 * 否则不同模型/时段的会话权重不可比。成本本身仍按
									 * 未命中输入 / 缓存命中 / 缓存写 / 输出四类分别计价（见 costOf）。
									 *
									 * 取不到（会话没被 retain / 没有用量）返回 0。
									 *
									 * @param id - 目标会话 id。
									 * @param model - 价格口径用的模型。
									 * @param peak - 是否按峰时价。
									 * @returns 该会话的预估花费（元）。
									 */
									tokensOf: (id, model, peak) => {
										try {
											const usage = ctx.sessions?.binding?.(id)?.session?.projections?.faceOf("tokenUsage")?.getSnapshot();
											// **必须用同一张价格表**：分母里的其它会话如果按内置表算、
											// 而被分摊的会话按同步表算，权重就不可比了。
											const info = costOf(usage, model, peak, resolvePrices(loadPriceCache()).prices);
											return info?.total ?? 0;
										} catch {
											return 0;
										}
									},
									/**
									 * 手动兜底：用户点击「我刚充值了」时调用。
									 * 与自动识别同一条路径 —— 只抬锚点、不动计数。
									 *
									 * @param total - 当前余额（没读到则不传）。
									 * @returns 是否记账成功。
									 */
									markTopUp: (total, amount) => {
										if (typeof total !== "number") return false;
										applyExternalChange(
											total,
											typeof amount === "number" ? amount : 0,
											baselineStage.activeSession,
											"topup"
										);
										baselineStage.store = readStore();
										baselineStage.runningBalance = total;
										return true;
									}
								})
							},
							BalanceHud
						)
					),
				"balance-hud: 右下角余额/花费 HUD"
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		// 纯函数随手导出，供离线冒烟测试直接验证（浏览器侧不会用到）。
		exports.__test = { parsePricingPage, MESSAGES, LOCALE_NS, normalizeLang, resolveLang, translate, readDshLocaleId, resolvePrices, loadPriceCache, savePriceCache, syncPrices, readModels, sessionModelOf, sessionModelsUsed, PRICING_DOC_URL, PRICES_CACHE_KEY, PRICING_ROUTE, MODELS_ROUTE, BUILTIN_PRICES_DATE, SYNC_INTERVAL_HOURS, DEFAULT_SYNC_HOURS, readBalance, costOf, isPeakHour, minutesUntilTierChange, beijingDateKey, defaultSettings, normalizeSettings, loadSettings, saveSettings, createSettingsStore, evaluateBudget, worstBudgetLevel, addDailySpent, loadDaily, formatMoney, formatCost, formatCostShort, formatTokens, formatClock, loadTracker, createTracker, checkoutSession, observeRead, classifyRead, applyExternalChange, accountLevelDelta, sessionSpentOf, readStore, writeStore, settingsKey: SETTINGS_KEY, dailyKey: DAILY_KEY };
		return module.exports;
	}
});
