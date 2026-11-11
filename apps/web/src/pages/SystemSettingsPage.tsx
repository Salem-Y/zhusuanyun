import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Result, Table, Tag, Typography } from 'antd';
import { RollbackOutlined } from '@ant-design/icons';
import { api, type UserAccount } from '../api';
import { ROLE_LABELS } from '../roles';
import { useSession } from '../App';

export default function SystemSettingsPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromProjectId = params.get('fromProject');

  const [users, setUsers] = useState<UserAccount[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 返回目标：来自具体项目则回项目工作台；来自项目列表或直接访问/项目已无权访问，则回项目列表。
  // 不使用浏览器 history，避免返回到登录页、外部页面或无权限项目。
  const [back, setBack] = useState<{ label: string; path: string }>({
    label: '返回项目列表',
    path: '/projects',
  });

  const isSysAdmin = session.user.role === 'SYS_ADMIN';

  useEffect(() => {
    if (!fromProjectId) return;
    api
      .getProject(fromProjectId)
      .then(() => setBack({ label: '返回项目工作台', path: `/projects/${fromProjectId}/overview` }))
      .catch(() => setBack({ label: '返回项目列表', path: '/projects' }));
  }, [fromProjectId]);

  useEffect(() => {
    if (!isSysAdmin) return;
    api
      .listUsers()
      .then(setUsers)
      .catch((e) => setError((e as Error).message));
  }, [isSysAdmin]);

  if (!isSysAdmin) {
    return (
      <Result
        status="403"
        title="无权访问"
        subTitle="系统设置仅系统管理员可查看。"
        extra={
          <Button type="primary" onClick={() => navigate('/projects')}>
            返回项目列表
          </Button>
        }
      />
    );
  }

  return (
    <Card
      size="small"
      title="系统设置 · 账号管理"
      extra={
        <Button icon={<RollbackOutlined />} onClick={() => navigate(back.path)}>
          {back.label}
        </Button>
      }
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={users}
        columns={[
          { title: '登录名', dataIndex: 'username' },
          { title: '姓名', dataIndex: 'displayName' },
          {
            title: '系统角色',
            dataIndex: 'role',
            render: (role: string) => <Tag color="blue">{ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role}</Tag>,
          },
          {
            title: '状态',
            dataIndex: 'isActive',
            width: 90,
            render: (active: boolean) =>
              active ? <Tag color="green">启用</Tag> : <Tag>已停用</Tag>,
          },
          { title: '参与项目数', dataIndex: 'projectCount', width: 110 },
          {
            title: '创建时间',
            dataIndex: 'createdAt',
            width: 170,
            render: (value: string) => new Date(value).toLocaleString('zh-CN'),
          },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        说明：账号的创建、口令重置与停用目前由系统管理员通过服务端脚本维护，界面化账号管理将在后续阶段开放；
        项目内的成员授权请在「项目设置 · 成员与权限」中维护。本页为只读列表，不含待保存的输入内容。
      </Typography.Paragraph>
    </Card>
  );
}
