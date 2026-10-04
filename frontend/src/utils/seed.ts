/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：地块 → 苗木批次 / 栽植 → 验收 → 补植
 * 所有 id 固定，保证 /plots/:id/seedlings、/plots/:id/plantings 深链一定命中真实数据。
 */
import { db, ROW_REVISION } from './db';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant } from '../types/replant';
import type { AerialItem, AerialPackage } from '../types/aerial';
import { calcSurvivalRate, rateLevel } from './rate';

const SEED_TIME = '2025-01-06T02:00:00.000Z';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  plotA: 'plot-donggang-3',
  plotB: 'plot-xiwan-a',
  plotC: 'plot-beiyu-b',
} as const;

function plotRow(row: Omit<Plot, 'createdAt' | 'updatedAt' | 'revision'>): Plot {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function seedlingRow(row: Omit<Seedling, 'createdAt' | 'updatedAt' | 'revision'>): Seedling {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function plantingRow(row: Omit<Planting, 'createdAt' | 'updatedAt' | 'revision'>): Planting {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function surveyRow(row: Omit<Survey, 'createdAt' | 'updatedAt' | 'revision' | 'grade' | 'gradeManual' | 'survivalRate' | 'source' | 'aerialItemId'>, total: number): Survey {
  const survivalRate = calcSurvivalRate(row.aliveCount, total);
  return {
    ...row,
    survivalRate,
    grade: rateLevel(survivalRate),
    gradeManual: false,
    source: 'field',
    aerialItemId: '',
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    revision: ROW_REVISION,
  };
}

function aerialPackageRow(row: Omit<AerialPackage, 'createdAt' | 'updatedAt' | 'revision'>): AerialPackage {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function aerialItemRow(row: Omit<AerialItem, 'createdAt' | 'updatedAt' | 'revision'>): AerialItem {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function replantRow(row: Omit<Replant, 'createdAt' | 'updatedAt' | 'revision'>): Replant {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

/**
 * 播种演示数据。调用方（initDatabase）已保证仅在主表为空时调用，因此天然幂等；
 * 这里再做一次防御：若已存在地块则直接返回。
 */
export async function seedDatabase(): Promise<void> {
  const exists = await db.plots.count();
  if (exists > 0) return;

  // ---------------- 地块（3 块，覆盖三种潮位带与三种底质） ----------------
  const plots: Plot[] = [
    plotRow({
      id: SEED_IDS.plotA,
      name: '东港南堤 3 号地块',
      areaMu: 46.5,
      tideZone: '中',
      substrate: '淤泥质',
      restoreMode: '造林',
      state: '跟踪中',
      missingCount: 1092,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.plotB,
      name: '西湾滩涂 A 区',
      areaMu: 32,
      tideZone: '低',
      substrate: '砂泥质',
      restoreMode: '补植',
      state: '跟踪中',
      missingCount: 0,
      lastReplantDate: '2025-04-20',
    }),
    plotRow({
      id: SEED_IDS.plotC,
      name: '北屿外滩 B 区',
      areaMu: 58.2,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '已验收',
      missingCount: 560,
      lastReplantDate: '2024-11-08',
    }),
  ];

  // ---------------- 苗木批次（每地块 2 批） ----------------
  const seedlings: Seedling[] = [
    seedlingRow({ id: 'seedling-a1', plotId: SEED_IDS.plotA, species: '秋茄', source: '自育苗', spec: '50cm 裸根苗', quantity: 3200, arrivalDate: '2024-04-05' }),
    seedlingRow({ id: 'seedling-a2', plotId: SEED_IDS.plotA, species: '桐花树', source: '外购', spec: '40cm 营养袋苗', quantity: 2400, arrivalDate: '2024-04-10' }),
    seedlingRow({ id: 'seedling-b1', plotId: SEED_IDS.plotB, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 1900, arrivalDate: '2024-04-28' }),
    seedlingRow({ id: 'seedling-b2', plotId: SEED_IDS.plotB, species: '秋茄', source: '外购', spec: '50cm 营养袋苗', quantity: 1600, arrivalDate: '2024-05-02' }),
    seedlingRow({ id: 'seedling-c1', plotId: SEED_IDS.plotC, species: '无瓣海桑', source: '外购', spec: '60cm 营养袋苗', quantity: 4400, arrivalDate: '2024-03-12' }),
    seedlingRow({ id: 'seedling-c2', plotId: SEED_IDS.plotC, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 3900, arrivalDate: '2024-03-16' }),
  ];

  // ---------------- 栽植记录（每地块 2 条，引用真实苗木批次） ----------------
  const plantings: Planting[] = [
    plantingRow({ id: 'planting-a1', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a1', plantDate: '2024-04-12', spacingM: 1, count: 3000, operator: '东港一班' }),
    plantingRow({ id: 'planting-a2', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a2', plantDate: '2024-04-15', spacingM: 0.8, count: 2200, operator: '东港二班' }),
    plantingRow({ id: 'planting-b1', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b1', plantDate: '2024-05-06', spacingM: 1.2, count: 1800, operator: '西湾一班' }),
    plantingRow({ id: 'planting-b2', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b2', plantDate: '2024-05-09', spacingM: 1, count: 1500, operator: '西湾二班' }),
    plantingRow({ id: 'planting-c1', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c1', plantDate: '2024-03-20', spacingM: 1.5, count: 4200, operator: '北屿一班' }),
    plantingRow({ id: 'planting-c2', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c2', plantDate: '2024-03-24', spacingM: 1.2, count: 3800, operator: '北屿二班' }),
  ];

  // 各地块栽植总株数，用于派生成活率
  const totalByPlot: Record<string, number> = {
    [SEED_IDS.plotA]: 5200,
    [SEED_IDS.plotB]: 3300,
    [SEED_IDS.plotC]: 8000,
  };

  // ---------------- 验收记录（每地块 2–3 个现场测次） ----------------
  const surveys: Survey[] = [
    surveyRow({ id: 'survey-a1', plotId: SEED_IDS.plotA, round: 1, date: '2024-06-20', aliveCount: 4680, avgHeightCm: 62 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a2', plotId: SEED_IDS.plotA, round: 2, date: '2024-09-18', aliveCount: 4420, avgHeightCm: 78 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a3', plotId: SEED_IDS.plotA, round: 3, date: '2025-03-15', aliveCount: 4108, avgHeightCm: 96 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-b1', plotId: SEED_IDS.plotB, round: 1, date: '2024-07-05', aliveCount: 2772, avgHeightCm: 41 }, totalByPlot[SEED_IDS.plotB]),
    surveyRow({ id: 'survey-b2', plotId: SEED_IDS.plotB, round: 2, date: '2024-10-12', aliveCount: 2112, avgHeightCm: 55 }, totalByPlot[SEED_IDS.plotB]),
    surveyRow({ id: 'survey-c1', plotId: SEED_IDS.plotC, round: 1, date: '2024-05-28', aliveCount: 7680, avgHeightCm: 70 }, totalByPlot[SEED_IDS.plotC]),
    surveyRow({ id: 'survey-c2', plotId: SEED_IDS.plotC, round: 2, date: '2024-08-30', aliveCount: 7440, avgHeightCm: 88 }, totalByPlot[SEED_IDS.plotC]),
  ];

  // 东港 3 号第 4 测次现场还没测，由航测判读回填占位（source='aerial'）
  const aerialBackfillRate = calcSurvivalRate(3978, totalByPlot[SEED_IDS.plotA]);
  const surveyA4Backfill: Survey = {
    id: 'survey-a4',
    plotId: SEED_IDS.plotA,
    round: 4,
    date: '2025-03-20',
    aliveCount: 3978,
    avgHeightCm: 108,
    survivalRate: aerialBackfillRate,
    grade: rateLevel(aerialBackfillRate),
    gradeManual: false,
    source: 'aerial',
    aerialItemId: 'aerial-item-a4',
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    revision: ROW_REVISION,
  };
  surveys.push(surveyA4Backfill);

  // ---------------- 补植计划（每地块 1 条，覆盖三种状态） ----------------
  const replants: Replant[] = [
    replantRow({ id: 'replant-a1', plotId: SEED_IDS.plotA, missingCount: 1092, planDate: '2025-04-10', species: '秋茄', state: '待补植' }),
    replantRow({ id: 'replant-b1', plotId: SEED_IDS.plotB, missingCount: 1188, planDate: '2025-04-18', species: '白骨壤', state: '已补植' }),
    replantRow({ id: 'replant-c1', plotId: SEED_IDS.plotC, missingCount: 560, planDate: '2024-11-05', species: '无瓣海桑', state: '已复核' }),
  ];

  // ---------------- 无人机航测判读包（演示回填 / 挂起 / 一致三种对账结果） ----------------
  const aerialPackages: AerialPackage[] = [
    aerialPackageRow({
      id: 'aerial-pkg-2025-03',
      packageId: 'UAV-2025-0320',
      sortie: 'sortie-2025-0320',
      flightDate: '2025-03-20',
      receivedAt: '2025-03-22T03:00:00.000Z',
      itemCount: 3,
    }),
  ];
  const aerialItems: AerialItem[] = [
    // 东港第 4 测次：现场还没测，判读回填
    aerialItemRow({
      id: 'aerial-item-a4',
      packageRef: 'aerial-pkg-2025-03',
      packageId: 'UAV-2025-0320',
      sortie: 'sortie-2025-0320',
      plotId: SEED_IDS.plotA,
      round: 4,
      survivalRate: aerialBackfillRate,
      avgHeightCm: 108,
      status: 'backfilled',
      rateDiff: null,
      heightDiff: null,
      note: '该测次尚无现场实测，判读值已回填，待现场补测后自动对账',
      resolveVerdict: null,
      resolvedAt: null,
      backfilledSurveyId: 'survey-a4',
    }),
    // 西湾第 2 测次：判读成活率 58% vs 现场 64%（差 6 个百分点），超阈值挂起
    aerialItemRow({
      id: 'aerial-item-b2',
      packageRef: 'aerial-pkg-2025-03',
      packageId: 'UAV-2025-0320',
      sortie: 'sortie-2025-0320',
      plotId: SEED_IDS.plotB,
      round: 2,
      survivalRate: 58,
      avgHeightCm: 55,
      status: 'suspended',
      rateDiff: 6,
      heightDiff: 0,
      note: '待复核：成活率相差 6 个百分点（容差 5）',
      resolveVerdict: null,
      resolvedAt: null,
      backfilledSurveyId: '',
    }),
    // 北屿第 2 测次：判读与现场基本一致
    aerialItemRow({
      id: 'aerial-item-c2',
      packageRef: 'aerial-pkg-2025-03',
      packageId: 'UAV-2025-0320',
      sortie: 'sortie-2025-0320',
      plotId: SEED_IDS.plotC,
      round: 2,
      survivalRate: 93,
      avgHeightCm: 90,
      status: 'matched',
      rateDiff: 0,
      heightDiff: 2,
      note: '',
      resolveVerdict: null,
      resolvedAt: null,
      backfilledSurveyId: '',
    }),
  ];

  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.aerialPackages, db.aerialItems],
    async () => {
      await db.plots.bulkPut(plots);
      await db.seedlings.bulkPut(seedlings);
      await db.plantings.bulkPut(plantings);
      await db.surveys.bulkPut(surveys);
      await db.replants.bulkPut(replants);
      await db.aerialPackages.bulkPut(aerialPackages);
      await db.aerialItems.bulkPut(aerialItems);
    },
  );
}
