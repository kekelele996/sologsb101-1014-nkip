/**
 * /interpretations 航测判读对账台
 * 导入监测中心无人机航测判读包，按地块 + 测次与现场验收对账：
 * 判读成活率与实测成活株数、株高差得多的挂起等复核（挂起期间不生成补植计划）；
 * 判读只回填还没实测的测次，已定级测次不被判读值顶掉；
 * 同一判读包重复交回来只留一份；导入失败只重试判读这一侧，现场测次照旧。
 * 消费模型：Interpretation、Survey、Plot、Planting；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Input,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { usePlotStore } from '../stores/plotStore';
import { useInterpretationStore } from '../stores/interpretationStore';
import {
  INTERPRETATION_STATUS_LABEL,
  INTERPRETATION_STATUS_OPTIONS,
  type Interpretation,
  type InterpretationStatus,
} from '../types/interpretation';
import type { Survey } from '../types/survey';
import { calcSurvivalRate, percentText, round1 } from '../utils/rate';

const { TextArea } = Input;

/** 示例判读包：第 4 测次无实测 → 回填；第 3 测次判读与实测差异大 → 挂起 */
const SAMPLE_PACKAGE = `{
  "packageId": "pkg-demo-001",
  "source": "无人机航测",
  "flownAt": "2025-06-01",
  "items": [
    { "plotId": "plot-donggang-3", "round": 4, "sortieNo": "架次-004", "interpretedRate": 80.8, "interpretedAliveCount": 4200, "avgHeightCm": 98, "interpretedDate": "2025-06-01" },
    { "plotId": "plot-donggang-3", "round": 3, "sortieNo": "架次-003", "interpretedRate": 57.7, "interpretedAliveCount": 3000, "avgHeightCm": 70, "interpretedDate": "2025-06-01" }
  ]
}`;

export default function InterpretationBoard() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const surveys = usePlotStore((state) => state.surveys);
  const plantings = usePlotStore((state) => state.plantings);
  const ready = usePlotStore((state) => state.ready);

  const interpretations = useInterpretationStore((state) => state.interpretations);
  const filters = useInterpretationStore((state) => state.filters);
  const setFilters = useInterpretationStore((state) => state.setFilters);
  const resetFilters = useInterpretationStore((state) => state.resetFilters);
  const selectedIds = useInterpretationStore((state) => state.selectedIds);
  const setSelectedIds = useInterpretationStore((state) => state.setSelectedIds);
  const importPackageText = useInterpretationStore((state) => state.importPackageText);
  const retryImport = useInterpretationStore((state) => state.retryImport);
  const resolve = useInterpretationStore((state) => state.resolve);
  const remove = useInterpretationStore((state) => state.remove);
  const lastImport = useInterpretationStore((state) => state.lastImport);

  const [rawText, setRawText] = useState('');
  const [importing, setImporting] = useState(false);

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  const totalByPlot = useMemo(() => {
    const map = new Map<string, number>();
    plantings.forEach((row) => map.set(row.plotId, (map.get(row.plotId) ?? 0) + row.count));
    return map;
  }, [plantings]);

  const surveyByPlotRound = useMemo(() => {
    const map = new Map<string, Survey>();
    surveys.forEach((row) => map.set(`${row.plotId}__${row.round}`, row));
    return map;
  }, [surveys]);

  const filtered = useMemo(() => {
    const key = filters.keyword.trim().toLowerCase();
    return interpretations
      .filter((row) => {
        if (filters.plotId !== 'all' && row.plotId !== filters.plotId) return false;
        if (filters.status !== 'all' && row.status !== filters.status) return false;
        if (key === '') return true;
        return (
          plotName(row.plotId).toLowerCase().includes(key) ||
          row.sortieNo.toLowerCase().includes(key) ||
          row.packageId.toLowerCase().includes(key) ||
          `第${row.round}`.includes(key)
        );
      })
      .sort((a, b) => b.interpretedDate.localeCompare(a.interpretedDate) || b.round - a.round);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interpretations, filters, plots]);

  const stats = useMemo(() => {
    const suspended = interpretations.filter((row) => row.status === 'suspended').length;
    const backfilled = interpretations.filter((row) => row.backfilled).length;
    return { total: interpretations.length, normal: interpretations.length - suspended, suspended, backfilled };
  }, [interpretations]);

  const handleImport = async (): Promise<void> => {
    if (rawText.trim() === '') {
      message.info('请先粘贴判读包 JSON 报文');
      return;
    }
    setImporting(true);
    const ok = await importPackageText(rawText);
    setImporting(false);
    if (ok) {
      message.success('判读包导入完成');
      setRawText('');
    } else {
      message.error('判读包导入失败，已保留现场测次，可修改后重试');
    }
  };

  const handleRetry = async (): Promise<void> => {
    setImporting(true);
    const ok = await retryImport();
    setImporting(false);
    if (ok) {
      message.success('判读包重试导入完成');
      setRawText('');
    } else {
      message.error('判读包重试仍失败，现场测次未受影响');
    }
  };

  const handleFile = async (file: File): Promise<boolean> => {
    const text = await file.text();
    setRawText(text);
    return false;
  };

  const columns: ColumnsType<Interpretation> = [
    {
      title: '地块',
      key: 'plot',
      width: 200,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{plotName(record.plotId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.source} · {record.sortieNo}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '测次',
      dataIndex: 'round',
      key: 'round',
      width: 84,
      align: 'center',
      render: (value: number) => <Tag color="blue">第 {value} 次</Tag>,
    },
    {
      title: '判读包',
      dataIndex: 'packageId',
      key: 'packageId',
      width: 150,
      render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
    },
    {
      title: '判读成活率',
      key: 'interpretedRate',
      width: 120,
      align: 'right',
      render: (_value, record) => percentText(record.interpretedRate),
    },
    {
      title: '判读株高',
      key: 'interpretedHeight',
      width: 110,
      align: 'right',
      render: (_value, record) => (record.avgHeightCm != null ? `${record.avgHeightCm} cm` : '—'),
    },
    {
      title: '实测成活率',
      key: 'measuredRate',
      width: 120,
      align: 'right',
      render: (_value, record) => {
        const survey = surveyByPlotRound.get(`${record.plotId}__${record.round}`) ?? null;
        if (survey === null) return <Tag color="cyan">待实测</Tag>;
        const total = totalByPlot.get(record.plotId) ?? 0;
        return percentText(calcSurvivalRate(survey.aliveCount, total));
      },
    },
    {
      title: '实测株高',
      key: 'measuredHeight',
      width: 110,
      align: 'right',
      render: (_value, record) => {
        const survey = surveyByPlotRound.get(`${record.plotId}__${record.round}`) ?? null;
        if (survey === null) return '—';
        return `${survey.avgHeightCm} cm`;
      },
    },
    {
      title: '差异',
      key: 'diff',
      width: 170,
      render: (_value, record) => {
        const survey = surveyByPlotRound.get(`${record.plotId}__${record.round}`) ?? null;
        if (survey === null) return <Tag color="cyan">回填测次</Tag>;
        const total = totalByPlot.get(record.plotId) ?? 0;
        const rateDiff = round1(Math.abs(record.interpretedRate - calcSurvivalRate(survey.aliveCount, total)));
        const heightDiff =
          record.avgHeightCm != null && survey.avgHeightCm > 0
            ? round1((Math.abs(record.avgHeightCm - survey.avgHeightCm) / survey.avgHeightCm) * 100)
            : null;
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text type={rateDiff > 10 ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
              成活率差 {rateDiff} 个百分点
            </Typography.Text>
            {heightDiff != null ? (
              <Typography.Text type={heightDiff > 15 ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
                株高差 {heightDiff}%
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '状态',
      key: 'status',
      width: 130,
      render: (_value, record) =>
        record.status === 'suspended' ? (
          <Tag icon={<WarningOutlined />} color="warning">
            {INTERPRETATION_STATUS_LABEL[record.status]}
          </Tag>
        ) : (
          <Tag icon={<CheckCircleOutlined />} color="success">
            {INTERPRETATION_STATUS_LABEL[record.status]}
          </Tag>
        ),
    },
    {
      title: '挂起原因',
      dataIndex: 'suspendReason',
      key: 'suspendReason',
      width: 220,
      render: (value: string) =>
        value !== '' ? (
          <Tooltip title={value}>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              {value}
            </Typography.Text>
          </Tooltip>
        ) : (
          '—'
        ),
    },
    {
      title: '对账时间',
      dataIndex: 'reconciledAt',
      key: 'reconciledAt',
      width: 170,
      render: (value: string) => value.replace('T', ' ').slice(0, 16),
    },
    {
      title: '操作',
      key: 'action',
      width: 170,
      render: (_value, record) => (
        <Space size={4}>
          {record.status === 'suspended' ? (
            <Popconfirm
              title="确认该判读挂起复核通过？"
              description="恢复为正常后，该地块可重新生成补植计划。"
              okText="复核通过"
              cancelText="取消"
              onConfirm={async () => {
                await resolve(record.id);
                message.success('已恢复为正常，补植计划生成限制解除');
              }}
            >
              <Button size="small" type="link" icon={<SafetyCertificateOutlined />}>
                复核通过
              </Button>
            </Popconfirm>
          ) : null}
          <Popconfirm
            title="确认删除该判读记录？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await remove(record.id);
              message.success('判读记录已删除');
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="判读记录" value={stats.total} suffix="条" tone="primary" icon={<CloudUploadOutlined />} />
        <StatBadge label="正常对账" value={stats.normal} suffix="条" tone="success" />
        <StatBadge
          label="挂起复核"
          value={stats.suspended}
          suffix="条"
          tone={stats.suspended > 0 ? 'warning' : 'default'}
          hint="判读与实测差异超阈值，挂起期间不生成补植计划"
        />
        <StatBadge label="回填测次" value={stats.backfilled} suffix="个" tone="info" hint="此前无实测、由判读回填的测次" />
      </div>

      {lastImport !== null ? (
        <Alert
          type={lastImport.ok ? 'success' : 'error'}
          showIcon
          style={{ marginBottom: 14 }}
          message={lastImport.ok ? '判读包导入成功' : '判读包导入失败'}
          description={
            <Space direction="vertical" size={4}>
              <span>{lastImport.message}</span>
              {lastImport.retriable ? (
                <Button size="small" type="primary" icon={<ReloadOutlined />} loading={importing} onClick={() => void handleRetry()}>
                  重试判读导入（现场测次未受影响）
                </Button>
              ) : null}
            </Space>
          }
        />
      ) : null}

      <Card
        title="航测判读包导入"
        style={{ marginBottom: 14 }}
        extra={
          <Space>
            <Upload accept=".json" showUploadList={false} beforeUpload={(file) => void handleFile(file as unknown as File)}>
              <Button icon={<CloudUploadOutlined />}>读取判读包文件</Button>
            </Upload>
            <Button
              onClick={() => {
                setRawText(SAMPLE_PACKAGE);
                message.info('已填入示例判读包，可直接导入体验');
              }}
            >
              填入示例
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <TextArea
            rows={5}
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            placeholder='粘贴监测中心交回的判读包 JSON，如：{"packageId":"pkg-2025-001","items":[{"plotId":"...","round":1,"interpretedRate":85.5}]}'
          />
          <Space>
            <Button type="primary" icon={<CloudUploadOutlined />} loading={importing} onClick={() => void handleImport()}>
              导入判读包
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              判读只回填还没实测的测次；已定级测次不被判读值顶掉；同一判读包重复交回只留一份。
            </Typography.Text>
          </Space>
        </Space>
      </Card>

      <Card title="判读对账记录">
        <FilterBar
          keyword={filters.keyword}
          onKeywordChange={(value: string) => setFilters({ keyword: value })}
          fields={[
            {
              key: 'plotId',
              label: '地块',
              options: plots.map((plot) => plot.id),
              optionLabels: Object.fromEntries(plots.map((plot) => [plot.id, plot.name])),
            },
            {
              key: 'status',
              label: '状态',
              options: [...INTERPRETATION_STATUS_OPTIONS],
              optionLabels: INTERPRETATION_STATUS_LABEL,
            },
          ]}
          values={{ plotId: filters.plotId, status: filters.status }}
          onChange={(key: string, value: string) => {
            if (key === 'plotId') setFilters({ plotId: value });
            if (key === 'status') setFilters({ status: value as InterpretationStatus | 'all' });
          }}
          onReset={resetFilters}
          resultText={`命中 ${filtered.length} / ${interpretations.length} 条`}
          extra={
            <Tag color={selectedIds.length > 0 ? 'purple' : 'default'}>已选 {selectedIds.length} 条</Tag>
          }
        />

        {interpretations.length === 0 && !ready ? (
          <EmptyPanel
            title="还没有航测判读记录"
            description="导入监测中心无人机航测判读包，按地块 + 测次与现场验收对账；差异大的挂起等复核，还没实测的测次由判读回填。"
            actionText="导入第一个判读包"
            onAction={() => {
              setRawText(SAMPLE_PACKAGE);
            }}
          />
        ) : (
          <Table<Interpretation>
            rowKey="id"
            size="middle"
            loading={!ready}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1500 }}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
            }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: <EmptyPanel title="没有符合筛选条件的判读记录" actionText="重置筛选" onAction={resetFilters} />,
            }}
          />
        )}
      </Card>
    </div>
  );
}
