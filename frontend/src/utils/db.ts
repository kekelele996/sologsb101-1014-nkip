/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - v3 新增无人机航测判读（判读包 / 判读条目）两表，验收记录补「数据来源」字段
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { AerialItem, AerialItemInput, AerialPackage, AerialPackageInput, AerialResolveVerdict } from '../types/aerial';
import { rateLevel } from './rate';
import { reconcileAerialWithSurvey } from './reconcile';
import { nowIso, today, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;
  aerialPackages!: Table<AerialPackage, string>;
  aerialItems!: Table<AerialItem, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：无人机航测判读对账（判读包 / 判读条目 + 验收来源） ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade, source',
        replants: 'id, plotId, planDate, state, species',
        // packageId 为业务唯一键（重复交回去重）；条目按地块 / 包 / 架次 / 对账状态索引
        aerialPackages: 'id, packageId, sortie, flightDate, receivedAt',
        aerialItems: 'id, packageRef, packageId, plotId, sortie, status, [plotId+round]',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();
        // 迁移 1：已有验收记录全部来自现场实测，判读不得顶掉
        await tx
          .table('surveys')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.source !== 'string') row.source = 'field';
            if (typeof row.aerialItemId !== 'string') row.aerialItemId = '';
          });

        // 迁移 2：历史数据没有判读来源，按架次补一个「历史航测」判读包占位留痕。
        // 历史现场记录一律视为现场实测（不回填、不挂起），补包只为保持判读台账完整。
        const surveys = (await tx.table('surveys').toArray()) as Survey[];
        if (surveys.length > 0) {
          const flightDate = surveys
            .map((row) => row.date)
            .filter((date) => typeof date === 'string' && date !== '')
            .sort()[0];
          const legacyPkg: AerialPackage = {
            id: 'aerial-pkg-legacy',
            packageId: 'LEGACY-SORTIE',
            sortie: 'legacy-sortie',
            flightDate: flightDate ?? '',
            receivedAt: stamp,
            itemCount: surveys.length,
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          };
          const legacyItems: AerialItem[] = surveys.map((row) => ({
            id: uuid('aerial-legacy'),
            packageRef: legacyPkg.id,
            packageId: legacyPkg.packageId,
            sortie: legacyPkg.sortie,
            plotId: row.plotId,
            round: row.round,
            survivalRate: row.survivalRate,
            avgHeightCm: row.avgHeightCm,
            status: 'matched',
            rateDiff: 0,
            heightDiff: 0,
            note: '历史数据按架次补录判读来源，现场验收记录维持原样',
            resolveVerdict: null,
            resolvedAt: null,
            backfilledSurveyId: '',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          }));
          await tx.table('aerialPackages').put(legacyPkg);
          await tx.table('aerialItems').bulkPut(legacyItems);
        }
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/** 删除地块并级联清理其下苗木批次、栽植、验收、补植计划与航测判读 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.aerialPackages, db.aerialItems],
    async () => {
      await db.seedlings.where('plotId').equals(id).delete();
      await db.plantings.where('plotId').equals(id).delete();
      await db.surveys.where('plotId').equals(id).delete();
      await db.replants.where('plotId').equals(id).delete();
      // 判读条目按地块清理；清理后重算各判读包的条目数，空包一并删除
      const packageRefs = (await db.aerialItems.where('plotId').equals(id).toArray()).map((item) => item.packageRef);
      await db.aerialItems.where('plotId').equals(id).delete();
      for (const ref of new Set(packageRefs)) {
        const count = await db.aerialItems.where('packageRef').equals(ref).count();
        if (count === 0) {
          await db.aerialPackages.delete(ref);
        } else {
          await db.aerialPackages.update(ref, { itemCount: count, updatedAt: nowIso() });
        }
      }
      await db.plots.delete(id);
    },
  );
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction('rw', db.seedlings, db.plantings, async () => {
    // 该批次已被栽植记录引用时一并清理，避免出现悬空引用
    await db.plantings.where('seedlingId').equals(id).delete();
    await db.seedlings.delete(id);
  });
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 写入一条现场验收记录，并同步与航测判读对账：
 * - 若该地块 + 测次原本只有航测回填记录，现场补测直接顶替为现场实测（人工已定的等级保留为现场等级）；
 * - 已存在现场实测记录时按普通更新处理；
 * - 写完后重放该地块 + 测次相关判读条目的对账。
 */
export async function putFieldSurvey(draft: Omit<
  Survey,
  'createdAt' | 'updatedAt' | 'revision' | 'grade' | 'gradeManual' | 'source' | 'aerialItemId'
> &
  Partial<Pick<Survey, 'grade' | 'gradeManual' | 'id'>>): Promise<Survey> {
  return db.transaction('rw', db.surveys, db.aerialItems, async () => {
    const existing =
      draft.id !== undefined
        ? await db.surveys.get(draft.id)
        : await db.surveys.where('[plotId+round]').equals([draft.plotId, draft.round]).first();
    const grade = draft.gradeManual ? (draft.grade ?? rateLevel(draft.survivalRate)) : rateLevel(draft.survivalRate);
    const stamp = nowIso();
    const row: Survey = {
      id: existing?.id ?? draft.id ?? uuid('survey'),
      plotId: draft.plotId,
      round: draft.round,
      date: draft.date,
      aliveCount: draft.aliveCount,
      avgHeightCm: draft.avgHeightCm,
      survivalRate: draft.survivalRate,
      grade,
      // 航测回填记录被现场补测顶替时，人工已定的等级作为现场等级保留
      gradeManual: draft.gradeManual ?? existing?.gradeManual ?? false,
      source: 'field',
      aerialItemId: '',
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.surveys.put(row);
    await rerunReconcile(draft.plotId, draft.round, existing?.source === 'aerial' ? existing.aerialItemId : '');
    return row;
  });
}

/** 删除现场验收记录；若删掉的是某判读条目回填的占位，则该条目退回回填态 */
export async function removeSurvey(id: string): Promise<void> {
  await db.transaction('rw', db.surveys, db.aerialItems, async () => {
    const target = await db.surveys.get(id);
    await db.surveys.delete(id);
    if (target && target.source === 'aerial' && target.aerialItemId !== '') {
      const item = await db.aerialItems.get(target.aerialItemId);
      if (item && item.status === 'backfilled') {
        await db.aerialItems.update(item.id, { backfilledSurveyId: '', updatedAt: nowIso() });
      }
    }
  });
}

/**
 * 按地块 + 测次重放对账：
 * 找到现场实测记录后，把该地块 + 测次未结案（挂起 / 一致）的判读条目重新比对；
 * 判读回填占位记录（source=aerial）不算现场实测，此时对应条目维持回填态。
 * promotedItemId：被本次现场补测顶替的回填占位所对应的判读条目，需从回填态转入对账。
 */
async function rerunReconcile(plotId: string, round: number, promotedItemId = ''): Promise<void> {
  const field = (await db.surveys.where('[plotId+round]').equals([plotId, round]).toArray()).find(
    (row) => row.source === 'field',
  );
  const items = await db.aerialItems
    .where('[plotId+round]')
    .equals([plotId, round])
    .filter(
      (item) =>
        item.status !== 'superseded' &&
        (item.status !== 'backfilled' || (promotedItemId !== '' && item.id === promotedItemId)),
    )
    .toArray();
  for (const item of items) {
    if (field === undefined) continue;
    const result = reconcileAerialWithSurvey({
      rate: item.survivalRate,
      heightCm: item.avgHeightCm,
      survey: field,
    });
    await db.aerialItems.update(item.id, {
      status: result.suspended ? 'suspended' : 'matched',
      rateDiff: result.rateDiff,
      heightDiff: result.heightDiff,
      note: result.suspended ? `待复核：${result.reason}` : '现场已补测，对账一致',
      // 出现新的现场实测后，之前的挂起复核结论作废，需要重新对账
      resolveVerdict: null,
      resolvedAt: null,
      backfilledSurveyId: item.id === promotedItemId ? '' : item.backfilledSurveyId,
      updatedAt: nowIso(),
    });
  }
}

/** 批量调整成活率等级（人工复核覆盖；航测回填占位记录不参与定级） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined && row.source === 'field')
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 补植完成回写：
 * 1）扣减地块缺株数；2）写入最近补植日期；3）按补植后的总株数重算最新一次验收的成活率。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;

    const nextMissing = Math.max(0, plot.missingCount - replant.missingCount);
    await db.plots.update(plot.id, {
      missingCount: nextMissing,
      lastReplantDate: today(),
      updatedAt: nowIso(),
    });

    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.count, 0);
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    if (surveys.length === 0) return;
    const latest = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc));
    // 补植后按「原成活株数 + 本次补植株数」重新计算成活率
    const aliveAfter = latest.aliveCount + replant.missingCount;
    const rate = total > 0 ? Math.round(Math.min(100, (aliveAfter / total) * 100) * 10) / 10 : latest.survivalRate;
    await db.surveys.update(latest.id, {
      aliveCount: aliveAfter,
      survivalRate: rate,
      grade: latest.gradeManual ? latest.grade : rateLevel(rate),
      updatedAt: nowIso(),
    });
  });
}

/** 推进补植状态（待补植 → 已补植 → 已复核），推进到「已补植」时触发回写 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
  if (next === '已补植') {
    await applyReplantCompletion(replantId);
  }
}

/* --------------------------- 无人机航测判读 --------------------------- */

export async function listAerialPackages(): Promise<AerialPackage[]> {
  const rows = await db.aerialPackages.toArray();
  return rows.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export async function listAerialItems(): Promise<AerialItem[]> {
  const rows = await db.aerialItems.toArray();
  return rows.sort(
    (a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round || b.createdAt.localeCompare(a.createdAt),
  );
}

export async function getAerialPackageByBusinessId(packageId: string): Promise<AerialPackage | undefined> {
  return db.aerialPackages.where('packageId').equals(packageId).first();
}

/** 判读包条目按地块 + 测次去重后，同一地块 + 测次保留最新交回的一条 */
function dedupeInputs(items: AerialItemInput[]): AerialItemInput[] {
  const map = new Map<string, AerialItemInput>();
  items.forEach((item) => map.set(`${item.plotId ?? ''}#${item.round}`, item));
  return [...map.values()];
}

export interface ImportAerialResult {
  packageId: string;
  sortie: string;
  itemCount: number;
  /** 与现场实测对账一致的条数 */
  matched: number;
  /** 差异过大挂起等复核的条数 */
  suspended: number;
  /** 该测次无现场实测、已用判读值回填的条数 */
  backfilled: number;
  /** 同一地块 + 测次被本包替代的旧判读条数 */
  superseded: number;
  /** 是否为同一判读包重复交回（内容整体替换，仍只保留一份） */
  resubmitted: boolean;
}

/**
 * 导入监测中心交回的判读包。
 *
 * 关键约束：
 * - 整个导入是单个 Dexie 事务，任一步失败整体回滚——不会出现"判读写了一半"；
 * - 事务只触碰航测两表与 surveys，且对 surveys 只新增/更新航测回填占位，
 *   绝不修改 source='field' 的现场测次（导入失败重试也只影响判读这一侧，现场照旧）；
 * - packageId 相同视为同一判读包重复交回，只留一份（先清旧条目再写新条目）；
 * - 同一地块 + 测次被更新的判读包覆盖时，旧条目标记 superseded 留痕；
 * - 已有现场实测的测次只做对账（超阈值挂起），判读值不回填、不顶掉已定级的记录；
 * - 无现场实测的测次才物化一条 source='aerial' 的占位验收记录。
 */
export async function importAerialPackage(input: AerialPackageInput): Promise<ImportAerialResult> {
  if (typeof input.packageId !== 'string' || input.packageId.trim() === '') {
    throw new Error('判读包缺少 packageId');
  }
  if (typeof input.sortie !== 'string' || input.sortie.trim() === '') {
    throw new Error('判读包缺少架次编号 sortie');
  }
  if (typeof input.flightDate !== 'string' || input.flightDate.trim() === '') {
    throw new Error('判读包缺少航测日期 flightDate');
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('判读包内没有任何判读结果');
  }

  // 引用解析在事务前完成（读操作）；解析失败直接抛错，一行数据都不会写入
  const plots = await db.plots.toArray();
  const nameToId = new Map(plots.map((plot) => [plot.name, plot.id]));
  const rawItems = dedupeInputs(input.items);
  const resolved = rawItems.map((item) => {
    // 统一按地块台账解析：plotId 必须命中现有地块；缺失 / 未知时退回按地块名匹配
    const plotId =
      typeof item.plotId === 'string' && plots.some((plot) => plot.id === item.plotId)
        ? item.plotId
        : nameToId.get(item.plotName ?? '');
    if (plotId === undefined) {
      throw new Error(`判读结果引用了不存在的地块：${item.plotId ?? item.plotName}（第 ${item.round} 测次）`);
    }
    return { ...item, plotId };
  });

  const packageId = input.packageId.trim();
  const sortie = input.sortie.trim();
  const flightDate = input.flightDate.trim();
  const plantings = await db.plantings.toArray();
  const totalByPlot = new Map<string, number>();
  plantings.forEach((row) => totalByPlot.set(row.plotId, (totalByPlot.get(row.plotId) ?? 0) + row.count));

  return db.transaction('rw', db.aerialPackages, db.aerialItems, db.surveys, async () => {
    const stamp = nowIso();
    const existingPkg = await db.aerialPackages.where('packageId').equals(packageId).first();
    const resubmitted = existingPkg !== undefined;
    const packageRowId = existingPkg?.id ?? uuid('aerial-pkg');

    // 同一判读包重复交回：旧条目整体作废（不留 superseded，因为是同一个包）
    if (existingPkg) {
      const oldItems = await db.aerialItems.where('packageRef').equals(existingPkg.id).toArray();
      // 旧条目建过的回填占位（还没被现场补测顶替的）先删除，随后按新包重建
      const staleSurveyIds = oldItems
        .filter((item) => item.backfilledSurveyId !== '')
        .map((item) => item.backfilledSurveyId);
      if (staleSurveyIds.length > 0) {
        const staleSurveys = await db.surveys.bulkGet(staleSurveyIds);
        const removable = staleSurveys.filter(
          (row): row is Survey => row !== undefined && row.source === 'aerial',
        );
        if (removable.length > 0) await db.surveys.bulkDelete(removable.map((row) => row.id));
      }
      await db.aerialItems.where('packageRef').equals(existingPkg.id).delete();
    }

    const counters = { matched: 0, suspended: 0, backfilled: 0, superseded: 0 };

    for (const entry of resolved) {
      // 其它判读包里同一地块 + 测次的未结案条目，被本次结果替代
      const rivals = await db.aerialItems
        .where('[plotId+round]')
        .equals([entry.plotId, entry.round])
        .filter((item) => item.packageRef !== packageRowId && item.status !== 'superseded')
        .toArray();
      for (const rival of rivals) {
        counters.superseded += 1;
        // 旧条目建的航测回填占位改挂到新条目下，避免删了又建导致 id 漂移
        let inheritedSurveyId = rival.backfilledSurveyId;
        if (inheritedSurveyId !== '') {
          const placeholder = await db.surveys.get(inheritedSurveyId);
          if (placeholder === undefined || placeholder.source !== 'aerial') inheritedSurveyId = '';
        }
        await db.aerialItems.update(rival.id, {
          status: 'superseded',
          note: `已被判读包 ${packageId}（架次 ${sortie}）的同测次结果替代`,
          backfilledSurveyId: '',
          updatedAt: stamp,
        });
      }

      const fieldSurvey = (await db.surveys.where('[plotId+round]').equals([entry.plotId, entry.round]).toArray()).find(
        (row) => row.source === 'field',
      );

      const itemId = uuid('aerial-item');
      const item: AerialItem = {
        id: itemId,
        packageRef: packageRowId,
        packageId,
        sortie,
        plotId: entry.plotId,
        round: entry.round,
        survivalRate: entry.survivalRate,
        avgHeightCm: entry.avgHeightCm,
        status: 'matched',
        rateDiff: 0,
        heightDiff: 0,
        note: '',
        resolveVerdict: null,
        resolvedAt: null,
        backfilledSurveyId: '',
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };

      if (fieldSurvey) {
        // 已有现场实测：只对账，判读值绝不回填、绝不改现场等级
        const result = reconcileAerialWithSurvey({
          rate: entry.survivalRate,
          heightCm: entry.avgHeightCm,
          survey: fieldSurvey,
        });
        item.status = result.suspended ? 'suspended' : 'matched';
        item.rateDiff = result.rateDiff;
        item.heightDiff = result.heightDiff;
        item.note = result.suspended ? `待复核：${result.reason}` : '';
        if (result.suspended) counters.suspended += 1;
        else counters.matched += 1;
      } else {
        // 该测次尚无现场实测：判读回填一条占位验收记录
        counters.backfilled += 1;
        item.status = 'backfilled';
        item.rateDiff = null;
        item.heightDiff = null;
        item.note = '该测次尚无现场实测，判读值已回填，待现场补测后自动对账';
        const total = totalByPlot.get(entry.plotId) ?? 0;
        const aliveCount = aliveCountFromRateLocal(entry.survivalRate, total);
        const inheritedRivals = rivals.filter((rival) => rival.backfilledSurveyId !== '');
        const inheritedId = inheritedRivals
          .map((rival) => rival.backfilledSurveyId)
          .find((id) => id !== '');
        const surveyId = inheritedId || uuid('survey');
        const placeholder: Survey = {
          id: surveyId,
          plotId: entry.plotId,
          round: entry.round,
          date: flightDate,
          aliveCount,
          avgHeightCm: entry.avgHeightCm,
          survivalRate: entry.survivalRate,
          grade: rateLevel(entry.survivalRate),
          gradeManual: false,
          source: 'aerial',
          aerialItemId: itemId,
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        };
        await db.surveys.put(placeholder);
        item.backfilledSurveyId = surveyId;
      }

      await db.aerialItems.put(item);
    }

    const pkg: AerialPackage = {
      id: packageRowId,
      packageId,
      sortie,
      flightDate,
      receivedAt: existingPkg?.receivedAt ?? stamp,
      itemCount: resolved.length,
      createdAt: existingPkg?.createdAt ?? stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.aerialPackages.put(pkg);

    return {
      packageId,
      sortie,
      itemCount: resolved.length,
      matched: counters.matched,
      suspended: counters.suspended,
      backfilled: counters.backfilled,
      superseded: counters.superseded,
      resubmitted,
    };
  });
}

/** 判读成活率换算成活株数（回填占位用），避免与 reconcile 形成循环依赖所以内置 */
function aliveCountFromRateLocal(rate: number, totalCount: number): number {
  if (totalCount <= 0) return 0;
  return Math.max(0, Math.min(totalCount, Math.round((rate / 100) * totalCount)));
}

export interface ResolveAerialResult {
  verdict: AerialResolveVerdict;
  /** 以航测判读为准时，会把回填/挂起的判读值固化成该测次的值 */
  surveyUpdated: boolean;
}

/**
 * 复核挂起的判读条目：
 * - 「以现场实测为准」：记录结论，条目按最新现场值重新对账后结案为 matched；
 * - 「以航测判读为准」：把判读成活率/株高回写到该测次的验收记录。
 *   若已有现场实测记录，回写仍保留 source='field'（现场人员负责，且仅在复核动作下发生）；
 *   若只有回填占位，则更新占位值并维持回填态等待现场补测。
 */
export async function resolveAerialItem(itemId: string, verdict: AerialResolveVerdict): Promise<ResolveAerialResult> {
  return db.transaction('rw', [db.aerialItems, db.surveys, db.plantings], async () => {
    const item = await db.aerialItems.get(itemId);
    if (!item) throw new Error('判读条目不存在');
    const stamp = nowIso();
    let surveyUpdated = false;

    if (verdict === '以现场实测为准') {
      const field = (await db.surveys.where('[plotId+round]').equals([item.plotId, item.round]).toArray()).find(
        (row) => row.source === 'field',
      );
      if (field) {
        const result = reconcileAerialWithSurvey({
          rate: item.survivalRate,
          heightCm: item.avgHeightCm,
          survey: field,
        });
        await db.aerialItems.update(item.id, {
          status: 'matched',
          rateDiff: result.rateDiff,
          heightDiff: result.heightDiff,
          note: `复核结案：采纳现场实测（成活率 ${field.survivalRate}% / 株高 ${field.avgHeightCm}cm）`,
          resolveVerdict: verdict,
          resolvedAt: stamp,
          updatedAt: stamp,
        });
      } else {
        await db.aerialItems.update(item.id, {
          status: 'backfilled',
          note: '复核结案：采纳现场实测口径，但现场记录缺失，保留判读回填等待补测',
          resolveVerdict: verdict,
          resolvedAt: stamp,
          updatedAt: stamp,
        });
      }
    } else {
      const surveys = await db.surveys.where('[plotId+round]').equals([item.plotId, item.round]).toArray();
      const total = (await db.plantings.where('plotId').equals(item.plotId).toArray()).reduce(
        (acc, row) => acc + row.count,
        0,
      );
      const aliveCount = aliveCountFromRateLocal(item.survivalRate, total);
      const field = surveys.find((row) => row.source === 'field');
      if (field) {
        await db.surveys.put({
          ...field,
          aliveCount,
          avgHeightCm: item.avgHeightCm,
          survivalRate: item.survivalRate,
          grade: field.gradeManual ? field.grade : rateLevel(item.survivalRate),
          updatedAt: stamp,
        });
        surveyUpdated = true;
      } else {
        const placeholder = surveys.find((row) => row.source === 'aerial');
        if (placeholder) {
          await db.surveys.put({
            ...placeholder,
            aliveCount,
            avgHeightCm: item.avgHeightCm,
            survivalRate: item.survivalRate,
            grade: rateLevel(item.survivalRate),
            updatedAt: stamp,
          });
          surveyUpdated = true;
        }
      }
      await db.aerialItems.update(item.id, {
        status: 'matched',
        rateDiff: 0,
        heightDiff: 0,
        note: `复核结案：采纳航测判读（成活率 ${item.survivalRate}% / 株高 ${item.avgHeightCm}cm）`,
        resolveVerdict: verdict,
        resolvedAt: stamp,
        updatedAt: stamp,
      });
    }

    return { verdict, surveyUpdated };
  });
}

/** 删除判读包：连同条目一起删除；条目建的航测回填占位（仍无现场实测）一并清理 */
export async function removeAerialPackage(packageRef: string): Promise<void> {
  const pkg = await db.aerialPackages.get(packageRef);
  if (!pkg) throw new Error('判读包不存在或已被删除');
  await db.transaction('rw', db.aerialPackages, db.aerialItems, db.surveys, async () => {
    const items = await db.aerialItems.where('packageRef').equals(packageRef).toArray();
    const placeholderIds = items
      .filter((item) => item.backfilledSurveyId !== '')
      .map((item) => item.backfilledSurveyId);
    if (placeholderIds.length > 0) {
      const rows = await db.surveys.bulkGet(placeholderIds);
      const removable = rows.filter((row): row is Survey => row !== undefined && row.source === 'aerial');
      if (removable.length > 0) await db.surveys.bulkDelete(removable.map((row) => row.id));
    }
    await db.aerialItems.where('packageRef').equals(packageRef).delete();
    await db.aerialPackages.delete(packageRef);
  });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
  /** v3 新增：无人机航测判读包 / 条目；导入旧版快照时可能缺失，按空数组兜底 */
  aerialPackages?: AerialPackage[];
  aerialItems?: AerialItem[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, aerialPackages, aerialItems] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.aerialPackages.toArray(),
    db.aerialItems.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    replants,
    aerialPackages,
    aerialItems,
  };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.aerialPackages, db.aerialItems],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.aerialPackages.clear(),
        db.aerialItems.clear(),
      ]);
      await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
      // 兼容旧版存档：缺少来源字段的验收记录一律视为现场实测
      await db.surveys.bulkPut(
        snapshot.surveys.map((row) => ({
          ...row,
          source: row.source ?? 'field',
          aerialItemId: row.aerialItemId ?? '',
          revision: ROW_REVISION,
        })),
      );
      await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.aerialPackages.bulkPut(
        (snapshot.aerialPackages ?? []).map((row) => ({ ...row, revision: ROW_REVISION })),
      );
      await db.aerialItems.bulkPut((snapshot.aerialItems ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.aerialPackages, db.aerialItems],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.aerialPackages.clear(),
        db.aerialItems.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, aerialPackages, aerialItems] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.aerialPackages.count(),
    db.aerialItems.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, aerialPackages, aerialItems };
}
