import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Input, Space, Table, Tag, Select, Typography, Empty } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { api, type Project } from '../api';
import { STATUS_LABELS } from '../roles';
import { useSession } from '../App';

export default function ProjectsPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 项目的创建、编辑与归档仅系统管理员负责（后端同样强制校验）。
  const isSysAdmin = session.user.role === 'SYS_ADMIN';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listProjects({ keyword, status });
      setProjects(result.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [keyword, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card size="small" title="项目列表">
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="按项目名称或编码搜索"
          allowClear
          style={{ width: 280 }}
          onSearch={(value) => setKeyword(value.trim())}
        />
        <Select
          style={{ width: 140 }}
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: '全部状态' },
            { value: 'ACTIVE', label: '在建' },
            { value: 'ARCHIVED', label: '已归档' },
          ]}
        />
        <Button onClick={load}>刷新</Button>
        {isSysAdmin && (
          <Link to="/projects/new">
            <Button type="primary" icon={<PlusOutlined />}>
              新建项目
            </Button>
          </Link>
        )}
      </Space>

      {!isSysAdmin && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message="以下为你被授权参与的项目"
          description="选择项目进入项目工作台；项目的创建与基础信息维护由系统管理员负责。"
        />
      )}

      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

      {projects.length === 0 && !loading ? (
        <Empty
          description={
            <Typography.Text type="secondary">
              当前筛选条件下没有项目。
              {isSysAdmin ? '可点击「新建项目」创建。' : '如有需要请联系系统管理员授权。'}
            </Typography.Text>
          }
        />
      ) : (
        <Table
          rowKey="id"
          loading={loading}
          dataSource={projects}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          columns={[
            { title: '项目编码', dataIndex: 'code', width: 170 },
            {
              title: '项目名称',
              dataIndex: 'name',
              render: (text, record) => <Link to={`/projects/${record.id}/overview`}>{text}</Link>,
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (value: string) => (
                <Tag color={value === 'ACTIVE' ? 'green' : 'default'}>{STATUS_LABELS[value] ?? value}</Tag>
              ),
            },
            { title: '成员数', dataIndex: 'memberCount', width: 90 },
            {
              title: '最近更新',
              dataIndex: 'updatedAt',
              width: 170,
              render: (value: string) => new Date(value).toLocaleString('zh-CN'),
            },
            {
              title: '操作',
              width: 90,
              render: (_: unknown, record: Project) => (
                <Button size="small" type="link" onClick={() => navigate(`/projects/${record.id}/overview`)}>
                  进入项目
                </Button>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}
