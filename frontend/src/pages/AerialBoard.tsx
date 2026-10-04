/**
 * /aerial 无人机航测判读对账台
 * 接收监测中心交回的判读包，按地块 + 测次与现场验收对账：
 * 差异超阈值的测次挂起等复核（挂起期间不生成补植计划）；
 * 判读只回填尚无现场实测的测次，已定级的现场测次不会被判读顶掉；
 * 同一判读包重复交回只留一份；导入失败只重试判读这一侧，现场测次照旧。
 * 消费模型：AerialPackage、AerialItem、Survey、Plot；复用组件：<StatBadge>、<EmptyPanel>、<RateTag>
 */
import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadProps } from 'antd';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  FieldTimeOutlined,
  PauseCircleOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import EmptyPanel from '../components/common/EmptyPanel';
import RateTag from '../components/common/RateTag';
import StatBadge from '../components/common/StatBadge';
import { usePlotStore } from '../stores/plotStore';
import { useAerialStore } from '../stores/aerialStore';
import { AERIAL_STATUS_LABEL, type AerialItem, type AerialPackage, type AerialResolveVerdict, type AerialStatus } from '../types/aerial';
import type { Survey } from '../types/survey';
import { parseAerialPackage, buildSampleAerialPackage } from '../utils/aerialImport';
import { download } from '../utils/export';
import { RECONCILE_HEIGHT_TOLERANCE_CM, RECONCILE_RATE_TOLERANCE } from '../utils/reconcile';
import { DB_SCHEMA_VERSION } from '../utils/db';

const STATUS_COLOR: Record<AerialStatus, string> = {
  matched: 'success',
  suspended: 'error',
  backfilled: 'processing',
  superseded: 'default',
};

export default function AerialBoard() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const surveys = usePlotStore((state) => state.surveys);
  const packages = useAerialStore((state) => state.packages);
  const items = useAerialStore((state) => state.items);
  const loading = useAerialStore((state) => state.loading);
  const ready = useAerialStore((state) => state.ready);
  const filters = useAerialStore((state) => state.filters);
  const setFilters = useAerialStore((state) => state.setFilters);
  const resetFilters = useAerialStore((state) => state.resetFilters);
  const importPackage = useAerialStore((state) => state.importPackage);
  const resolveItem = useAerialStore((state) => state.resolveItem);
  const removePackage = useAerialStore((state) => state.removePackage);
  const lastMessage = useAerialStore((state) => state.lastMessage);

  const [resolving, setResolving] = useState<AerialItem | null>(null);
  const [verdict, setVerdict] = useState<AerialResolveVerdict>('以现场实测为准');
  const [submitting, setSubmitting] = useState(false);
  const [detail, setDetail] = useState<AerialItem | null>(null);
  const importingRef = useRef(false);

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  /** 同一地块 + 测次的现场实测记录（回填占位不算现场） */
  const fieldSurveyOf = (plotId: string, round: number): Survey | undefined =>
    surveys.find((row) => row.plotId === plotId && row.round === round && row.source === 'field') ??
    surveys.find((row) => row.plotId === plotId && row.round === round && row.source === 'aerial') ??
    undefined;

  const stats = useMemo(() => {
    const active = items.filter((item) => item.status !== 'superseded');
    return {
      pkgCount: packages.length,
      itemCount: active.length,
      suspended: active.filter((item) => item.status === 'suspended').length,
      backfilled: active.filter((item) => item.status === 'backfilled').length,
      matched: active.filter((item) => item.status === 'matched').length,
    };
  }, [packages, items]);

  const filtered = useMemo(() => {
    const key = filters.keyword.trim().toLowerCase();
    return items.filter((item) => {
      if (filters.plotId !== 'all' && item.plotId !== filters.plotId) return false;
      if (filters.status !== 'all' && item.status !== filters.status) return false;
      if (key === '') return true;
      return (
        plotName(item.plotId).toLowerCase().includes(key) ||
        item.packageId.toLowerCase().includes(key) ||
        item.sortie.toLowerCase().includes(key)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filters, plots]);

  const suspendedItems = items.filter((item) => item.status === 'suspended');

  const handleUpload: UploadProps['beforeUpload'] = (file) => {
    if (importingRef.current) return false;
    importingRef.current = true;
    void (async () => {
      try {
        const text = await (file as unknown as File).text();
        const parsed = parseAerialPackage(text);
        if (!parsed.ok || parsed.data === null) {
          message.error({ content: parsed.message, duration: 6 });
          return;
        }
        try {
          const result = await importPackage(parsed.data);
          message.success(
            result.resubmitted
              ? `判读包 ${result.packageId} 重复交回，已替换为最新内容（只保留一份）`
              : `判读包 ${result.packageId} 导入成功：一致 ${result.matched} / 挂起 ${result.suspended} / 回填 ${result.backfilled}`,
            6,
          );
          if (result.suspended > 0) {
            message.warning(`有 ${result.suspended} 条测次差异过大已挂起，复核结案前不会生成补植计划`, 6);
          }
        } catch (error) {
          // 事务整体回滚：现场测次原样保留，只提示重新交回判读包即可
          message.error({
            content: `判读包导入失败：${error instanceof Error ? error.message : '未知错误'}。现场测次未受影响，修正判读包后可重新交回。`,
            duration: 8,
          });
        }
      } finally {
        importingRef.current = false;
      }
    })();
    return false;
  };

  const handleDownloadSample = (): void => {
    download('uav-aerial-package.sample.json', buildSampleAerialPackage(), 'application/json;charset=utf-8');
    message.success('已下载判读包样例，可按该格式交回');
  };

  const openResolve = (item: AerialItem): void => {
    setResolving(item);
    setVerdict('以现场实测为准');
  };

  const handleResolveSubmit = async (): Promise<void> => {
    if (resolving === null) return;
    setSubmitting(true);
    try {
      await resolveItem(resolving.id, verdict);
      message.success(`已按「${verdict}」结案，地块 ${plotName(resolving.plotId)} 第 ${resolving.round} 测次`);
      setResolving(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '复核失败');
    } finally {
      setSubmitting(false);
    }
  };

  const packageColumns: ColumnsType<AerialPackage> = [
    {
      title: '判读包编号',
      dataIndex: 'packageId',
      key: 'packageId',
      render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
    },
    { title: '无人机架次', dataIndex: 'sortie', key: 'sortie' },
    { title: '航测日期', dataIndex: 'flightDate', key: 'flightDate', width: 120 },
    {
      title: '交回时间',
      dataIndex: 'receivedAt',
      key: 'receivedAt',
      width: 180,
      render: (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false }),
    },
    {
      title: '条目',
      dataIndex: 'itemCount',
      key: 'itemCount',
      width: 80,
      align: 'right',
      render: (value: number) => `${value} 条`,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_value, record) => (
        <Popconfirm
          title="删除该判读包？"
          description="条目与尚未现场补测的回填占位会一并删除，现场实测记录不受影响。"
          okText="删除"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          onConfirm={async () => {
            await removePackage(record.id);
            message.success('判读包已删除');
          }}
        >
          <Button size="small" type="link" danger icon={<DeleteOutlined />}>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const itemColumns: ColumnsType<AerialItem> = [
    {
      title: '判读包 / 架次',
      key: 'pkg',
      width: 210,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.packageId}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <RocketOutlined /> {record.sortie}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '地块 / 测次',
      key: 'plot',
      width: 200,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{plotName(record.plotId)}</span>
          <Tag color="blue" style={{ width: 'fit-content' }}>
            第 {record.round} 测次
          </Tag>
        </Space>
      ),
    },
    {
      title: '航测判读',
      key: 'aerial',
      width: 180,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <RateTag rate={record.survivalRate} size="small" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            株高 {record.avgHeightCm} cm
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '现场实测',
      key: 'field',
      width: 190,
      render: (_value, record) => {
        const field = fieldSurveyOf(record.plotId, record.round);
        if (field === undefined || field.source === 'aerial') {
          return <Tag color="processing">现场未实测 · 判读已回填</Tag>;
        }
        return (
          <Space direction="vertical" size={0}>
            <RateTag rate={field.survivalRate} level={field.grade} manual={field.gradeManual} size="small" />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              株高 {field.avgHeightCm} cm · {field.date}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '差异',
      key: 'diff',
      width: 150,
      render: (_value, record) => {
        if (record.status === 'backfilled') return <Typography.Text type="secondary">待现场补测</Typography.Text>;
        const rateOver = (record.rateDiff ?? 0) > RECONCILE_RATE_TOLERANCE;
        const heightOver = (record.heightDiff ?? 0) > RECONCILE_HEIGHT_TOLERANCE_CM;
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text type={rateOver ? 'danger' : undefined} style={{ fontSize: 12 }}>
              成活率差 {record.rateDiff ?? 0} pp
            </Typography.Text>
            <Typography.Text type={heightOver ? 'danger' : undefined} style={{ fontSize: 12 }}>
              株高差 {record.heightDiff ?? 0} cm
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '对账状态',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (value: AerialStatus, record) => (
        <Space direction="vertical" size={2}>
          <Tag color={STATUS_COLOR[value]}>{AERIAL_STATUS_LABEL[value]}</Tag>
          {record.resolveVerdict !== null ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.resolveVerdict}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 170,
      fixed: 'right',
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => setDetail(record)}>
            详情
          </Button>
          {record.status === 'suspended' ? (
            <Button size="small" type="link" danger icon={<SafetyCertificateOutlined />} onClick={() => openResolve(record)}>
              复核结案
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="判读包" value={stats.pkgCount} suffix="份" tone="primary" icon={<RocketOutlined />} />
        <StatBadge label="判读条目" value={stats.itemCount} suffix="条" tone="info" />
        <StatBadge
          label="挂起等复核"
          value={stats.suspended}
          suffix="条"
          tone={stats.suspended > 0 ? 'danger' : 'default'}
          icon={<PauseCircleOutlined />}
          hint="判读与现场差异超容差的测次；挂起期间不生成补植计划"
        />
        <StatBadge label="判读回填" value={stats.backfilled} suffix="条" tone="warning" hint="该测次尚无现场实测，判读值临时占位" />
        <StatBadge label="对账一致" value={stats.matched} suffix="条" tone="success" />
        <StatBadge label="结构版本" value={`v${DB_SCHEMA_VERSION}`} suffix="· 航测判读" tone="info" />
      </div>

      {suspendedItems.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${suspendedItems.length} 条测次判读与现场实测差异过大，已挂起等复核`}
          description={
            <Space direction="vertical" size={2}>
              {suspendedItems.map((item) => (
                <span key={item.id}>
                  {plotName(item.plotId)} 第 {item.round} 测次：{item.note}；复核结案前该地块不生成补植计划
                </span>
              ))}
            </Space>
          }
        />
      ) : null}

      {lastMessage !== '' ? (
        <Alert type="info" showIcon style={{ marginBottom: 14 }} message={lastMessage} />
      ) : null}

      <Card
        title={
          <Space>
            <FieldTimeOutlined />
            无人机航测判读包（按架次交回）
          </Space>
        }
        extra={
          <Space wrap>
            <Upload accept=".json" showUploadList={false} beforeUpload={handleUpload} disabled={plots.length === 0}>
              <Button type="primary" icon={<CloudUploadOutlined />} disabled={plots.length === 0}>
                交回判读包
              </Button>
            </Upload>
            <Button icon={<DownloadOutlined />} onClick={handleDownloadSample}>
              下载判读包样例
            </Button>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          同一判读包编号重复交回只保留一份（按最新内容替换）；导入在单事务内完成，失败整体回滚——
          <strong>只影响判读这一侧，现场测次照旧</strong>，修正判读包后重新交回即可。
        </Typography.Paragraph>
        {packages.length === 0 && !loading ? (
          <EmptyPanel
            title="还没有交回过航测判读包"
            description="监测中心无人机航测完成后，把判读结果 JSON 交回这里；系统按地块 + 测次自动与现场验收对账。"
            actionText="下载判读包样例"
            onAction={handleDownloadSample}
            icon={<RocketOutlined />}
          />
        ) : (
          <Table<AerialPackage>
            rowKey="id"
            size="middle"
            loading={loading || !ready}
            columns={packageColumns}
            dataSource={packages}
            pagination={false}
          />
        )}
      </Card>

      <Card
        title="判读 × 现场对账明细"
        extra={
          <Space size={12} wrap>
            <Select
              style={{ minWidth: 200 }}
              value={filters.plotId}
              onChange={(value: string) => setFilters({ plotId: value })}
              options={[
                { value: 'all', label: '全部地块' },
                ...plots.map((plot) => ({ value: plot.id, label: plot.name })),
              ]}
            />
            <Select
              style={{ minWidth: 140 }}
              value={filters.status}
              onChange={(value: AerialStatus | 'all') => setFilters({ status: value })}
              options={[
                { value: 'all', label: '全部状态' },
                ...(['matched', 'suspended', 'backfilled', 'superseded'] as AerialStatus[]).map((value) => ({
                  value,
                  label: AERIAL_STATUS_LABEL[value],
                })),
              ]}
            />
            <Button onClick={resetFilters}>重置筛选</Button>
          </Space>
        }
      >
        {items.length === 0 && !loading ? (
          <EmptyPanel
            title="暂无判读条目"
            description="交回判读包后，每个地块 + 测次的对账结果会列在这里。"
          />
        ) : (
          <Table<AerialItem>
            rowKey="id"
            size="middle"
            loading={loading || !ready}
            columns={itemColumns}
            dataSource={filtered}
            scroll={{ x: 1320 }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            rowClassName={(record) => (record.status === 'suspended' ? 'aerial-row-suspended' : '')}
          />
        )}
      </Card>

      <Modal
        title="挂起测次复核"
        open={resolving !== null}
        onCancel={() => setResolving(null)}
        onOk={() => void handleResolveSubmit()}
        confirmLoading={submitting}
        okText="确认结案"
        cancelText="取消"
      >
        {resolving !== null ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Alert type="warning" showIcon message={resolving.note} />
            <div>
              {plotName(resolving.plotId)} 第 {resolving.round} 测次：航测判读成活率 {resolving.survivalRate}% /
              株高 {resolving.avgHeightCm}cm
            </div>
            <Radio.Group value={verdict} onChange={(event) => setVerdict(event.target.value as AerialResolveVerdict)}>
              <Space direction="vertical">
                <Radio value="以现场实测为准">以现场实测为准（保留现场株数与株高，判读差异销账）</Radio>
                <Radio value="以航测判读为准">以航测判读为准（按判读成活率 / 株高回写该测次）</Radio>
              </Space>
            </Radio.Group>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              复核结案后该地块解除挂起，可正常生成补植计划。
            </Typography.Text>
          </Space>
        ) : null}
      </Modal>

      <Modal
        title="判读条目详情"
        open={detail !== null}
        onCancel={() => setDetail(null)}
        footer={
          detail?.status === 'suspended' ? (
            <Button
              type="primary"
              danger
              onClick={() => {
                openResolve(detail);
                setDetail(null);
              }}
            >
              去复核结案
            </Button>
          ) : (
            <Button onClick={() => setDetail(null)}>关闭</Button>
          )
        }
      >
        {detail !== null ? (
          <Space direction="vertical" size={6}>
            <div>判读包：{detail.packageId}</div>
            <div>架次：{detail.sortie}</div>
            <div>
              地块 / 测次：{plotName(detail.plotId)} / 第 {detail.round} 测次
            </div>
            <div>
              判读：成活率 {detail.survivalRate}% · 平均株高 {detail.avgHeightCm} cm
            </div>
            <div>对账状态：{AERIAL_STATUS_LABEL[detail.status]}</div>
            {detail.rateDiff !== null ? <div>成活率差：{detail.rateDiff} 个百分点（容差 {RECONCILE_RATE_TOLERANCE}）</div> : null}
            {detail.heightDiff !== null ? <div>株高差：{detail.heightDiff} cm（容差 {RECONCILE_HEIGHT_TOLERANCE_CM}）</div> : null}
            {detail.note !== '' ? <div>说明：{detail.note}</div> : null}
            {detail.resolveVerdict !== null ? (
              <div>
                复核结论：{detail.resolveVerdict}
                {detail.resolvedAt !== null ? `（${new Date(detail.resolvedAt).toLocaleString('zh-CN', { hour12: false })}）` : ''}
              </div>
            ) : null}
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
