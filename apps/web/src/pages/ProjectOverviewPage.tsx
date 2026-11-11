import { Alert, Card, Col, Descriptions, Empty, Row, Tag, Typography } from 'antd';
import { STATUS_LABELS } from '../roles';
import { useProject } from '../project/ProjectContext';

export default function ProjectOverviewPage() {
  const { project, members } = useProject();
  const today = new Date().toLocaleDateString('zh-CN');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" title="项目总览">
        <Descriptions column={2} size="small" bordered>
          <Descriptions.Item label="项目编码">{project.code}</Descriptions.Item>
          <Descriptions.Item label="项目状态">
            <Tag color={project.status === 'ACTIVE' ? 'green' : 'default'}>
              {STATUS_LABELS[project.status] ?? project.status}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="项目名称" span={2}>
            {project.name}
          </Descriptions.Item>
          <Descriptions.Item label="项目说明" span={2}>
            {project.description || <span className="muted">未填写</span>}
          </Descriptions.Item>
          <Descriptions.Item label="项目成员">{members.length} 人（详见「项目设置 · 成员与权限」）</Descriptions.Item>
          <Descriptions.Item label="数据截止日期">{today}（页面访问日）</Descriptions.Item>
        </Descriptions>
      </Card>

      <Row gutter={16}>
        <Col span={12}>
          <Card size="small" title="成本与经营概况" style={{ height: '100%' }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <div style={{ textAlign: 'left', display: 'inline-block' }}>
                  <div>尚未编制目标成本</div>
                  <div>尚无确认实际成本</div>
                  <div>尚未形成批准预测</div>
                </div>
              }
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              成本数据在「成本工作台」维护；未编制前本页不展示任何估算或占位金额。
            </Typography.Text>
          </Card>
        </Col>
        <Col span={12}>
          <Card size="small" title="核算口径（当前固定管理口径）" style={{ height: '100%' }}>
            <Typography.Paragraph style={{ marginBottom: 8, fontSize: 13 }}>
              · 成本不含可抵扣进项税，不可抵扣税额按规则计入成本；
            </Typography.Paragraph>
            <Typography.Paragraph style={{ marginBottom: 8, fontSize: 13 }}>
              · 收入不含增值税；收付款按实际金额登记，收付款不等同于收入和成本；
            </Typography.Paragraph>
            <Typography.Paragraph style={{ marginBottom: 0, fontSize: 13 }}>
              · 数量和单价最多 6 位小数，正式金额 2 位小数，由后端十进制计算。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>

      <Alert
        type="info"
        showIcon
        message="收入与收付款、价格资料、事项与审批、报告中心尚未开放"
        description="以上入口已在左侧导航标注「未开放」，将在对应业务实现并通过验收后启用。"
      />
    </div>
  );
}
