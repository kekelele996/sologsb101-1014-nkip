/**
 * 判读包文件解析（监测中心交回的 JSON）
 * 纯本地解析，不经过任何服务端；结构错误时给出逐条原因，调用方据此提示，
 * 导入失败只影响判读这一侧，现场验收数据完全不触碰。
 */
import type { AerialPackageInput } from '../types/aerial';
import { validateAerialItem } from './reconcile';

export interface AerialParseResult {
  ok: boolean;
  message: string;
  /** 判读包编号（即使解析失败也尽量带出来，便于提示） */
  packageId: string;
  data: AerialPackageInput | null;
}

/** 解析并校验判读包 JSON 文本 */
export function parseAerialPackage(text: string): AerialParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'JSON 解析失败，请确认判读包文件内容完整。', packageId: '', data: null };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '判读包格式不正确：顶层必须是对象。', packageId: '', data: null };
  }
  const data = raw as Record<string, unknown>;
  const packageId = typeof data.packageId === 'string' ? data.packageId : '';
  if (packageId === '') {
    return { ok: false, message: '判读包缺少 packageId（判读包编号）。', packageId, data: null };
  }
  if (typeof data.sortie !== 'string' || data.sortie.trim() === '') {
    return { ok: false, message: `判读包 ${packageId} 缺少 sortie（无人机架次编号）。`, packageId, data: null };
  }
  if (typeof data.flightDate !== 'string' || data.flightDate.trim() === '') {
    return { ok: false, message: `判读包 ${packageId} 缺少 flightDate（航测日期）。`, packageId, data: null };
  }
  if (!Array.isArray(data.items)) {
    return { ok: false, message: `判读包 ${packageId} 缺少 items 数组。`, packageId, data: null };
  }
  if (data.items.length === 0) {
    return { ok: false, message: `判读包 ${packageId} 的 items 为空，没有任何判读结果。`, packageId, data: null };
  }

  const errors: string[] = [];
  const items: AerialPackageInput['items'] = [];
  const seen = new Set<string>();
  data.items.forEach((rawItem, index) => {
    const result = validateAerialItem(rawItem, index);
    if (!result.ok || result.item === undefined) {
      errors.push(result.message);
      return;
    }
    const dedupeKey = `${result.item.plotId ?? result.item.plotName ?? ''}#${result.item.round}`;
    if (seen.has(dedupeKey)) return; // 同一地块 + 测次重复条目，保留首条
    seen.add(dedupeKey);
    items.push(result.item);
  });
  if (errors.length > 0) {
    return {
      ok: false,
      message: `判读包 ${packageId} 有 ${errors.length} 条结果无法识别：${errors.slice(0, 3).join('；')}${
        errors.length > 3 ? ' 等' : ''
      }。`,
      packageId,
      data: null,
    };
  }

  return {
    ok: true,
    message: `判读包 ${packageId} 校验通过，共 ${items.length} 条结果。`,
    packageId,
    data: {
      packageId,
      sortie: data.sortie.trim(),
      flightDate: data.flightDate.trim(),
      items,
    },
  };
}

/** 生成一份演示判读包 JSON 文本（供下载试导入） */
export function buildSampleAerialPackage(): string {
  const sample: AerialPackageInput = {
    packageId: 'UAV-DEMO-0001',
    sortie: 'sortie-demo-0001',
    flightDate: '2025-04-01',
    items: [
      { plotName: '东港南堤 3 号地块', round: 5, survivalRate: 80.5, avgHeightCm: 112 },
      { plotName: '西湾滩涂 A 区', round: 3, survivalRate: 72, avgHeightCm: 60 },
    ],
  };
  return JSON.stringify(sample, null, 2);
}
