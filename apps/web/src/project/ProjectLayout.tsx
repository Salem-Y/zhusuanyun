import { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Button, Layout, Menu, Result, Spin, Tag } from 'antd';
import {
  AccountBookOutlined,
  AuditOutlined,
  ControlOutlined,
  FileTextOutlined,
  HomeOutlined,
  PayCircleOutlined,
  SettingOutlined,
  TagsOutlined,
} from '@ant-design/icons';
import { api, type Project, type ProjectMemberInfo } from '../api';
import AppHeader from '../components/AppHeader';
import { useSession } from '../App';
import { ProjectContext } from './ProjectContext';

export default function ProjectLayout({ onLogout }: { onLogout: () => void }) {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const session = useSession();

  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<ProjectMemberInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ status?: number; message: string } | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    // 切换项目时先清空上一项目数据，再由后端重新校验权限。
    setLoading(true);
    setError(null);
    setProject(null);
    setMembers([]);
    try {
      const detail = await api.getProject(id);
      const memberList = await api.listMembers(id).catch(() => [] as ProjectMemberInfo[]);
      setProject(detail);
      setMembers(memberList);
    } catch (e) {
      setError({ status: (e as { status?: number }).status, message: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const contextValue = useMemo(() => {
    if (!project) return null;
    return { project, members, reload: load };
  }, [project, members, load]);

  if (error) {
    return (
      <Layout style={{ minHeight: '100vh' }}>
        <AppHeader onLogout={onLogout} />
        <Layout.Content style={{ padding: 40 }}>
          <Result
            status={error.status === 403 ? '403' : 'error'}
            title={
              error.status === 403
                ? '无权访问该项目'
                : error.status === 404
                  ? '项目不存在或已被删除'
                  : '项目加载失败'
            }
            subTitle={error.message}
            extra={
              <Button type="primary" onClick={() => navigate('/projects')}>
                返回项目列表
              </Button>
            }
          />
        </Layout.Content>
      </Layout>
    );
  }

  if (loading || !project || !contextValue) {
    return (
      <Layout style={{ minHeight: '100vh' }}>
        <AppHeader onLogout={onLogout} />
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
          <Spin size="large" tip="正在进入项目…" />
        </div>
      </Layout>
    );
  }

  const section = location.pathname.split('/')[3] ?? 'overview';
  const subSection = location.pathname.split('/')[4] ?? '';
  const selectedKey =
    section === 'cost'
      ? subSection
        ? `cost-${subSection}`
        : 'cost-comparison'
      : section === 'revenue' && subSection
        ? `${section}-${subSection}`
        : section;
  const isSysAdmin = session.user.role === 'SYS_ADMIN';

  const notOpen = (label: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {label}
      <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}>未开放</Tag>
    </span>
  );

  const menuItems = [
    { key: 'overview', icon: <HomeOutlined />, label: '项目总览' },
    {
      key: 'cost',
      icon: <AccountBookOutlined />,
      label: '成本工作台',
      children: [
        { key: 'cost-comparison', label: '成本测算总账' },
        { key: 'cost-process', label: '过程成本统计' },
      ],
    },
    {
      key: 'revenue',
      icon: <PayCircleOutlined />,
      label: '收入与收付款',
      children: [{ key: 'revenue-boq', label: '合同清单' }],
    },
    { key: 'prices', icon: <TagsOutlined />, label: notOpen('价格资料'), disabled: true },
    { key: 'matters', icon: <AuditOutlined />, label: notOpen('事项与审批'), disabled: true },
    { key: 'reports', icon: <FileTextOutlined />, label: notOpen('报告中心'), disabled: true },
    { type: 'divider' as const },
    { key: 'settings', icon: <SettingOutlined />, label: '项目设置' },
    ...(isSysAdmin
      ? [{ key: 'system', icon: <ControlOutlined />, label: '系统设置' }]
      : []),
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <AppHeader onLogout={onLogout} project={{ id: project.id, code: project.code, name: project.name }} />
      <Layout>
        <Layout.Sider width={208} theme="dark">
          <Menu
            theme="dark"
            mode="inline"
            items={menuItems}
            selectedKeys={[selectedKey]}
            defaultOpenKeys={['revenue', 'cost']}
            onClick={({ key }) => {
              if (key === 'system') {
                navigate(`/settings/system?fromProject=${project.id}`);
              } else if (key === 'revenue-boq') {
                navigate(`/projects/${project.id}/revenue/boq`);
              } else if (key === 'cost-comparison') {
                navigate(`/projects/${project.id}/cost/comparison`);
              } else if (key === 'cost-process') {
                navigate(`/projects/${project.id}/cost/process`);
              } else if (key !== 'revenue' && key !== 'cost') {
                navigate(`/projects/${project.id}/${key}`);
              }
            }}
            style={{ paddingTop: 8 }}
          />
        </Layout.Sider>
        <Layout.Content style={{ padding: 20, minWidth: 0 }}>
          <ProjectContext.Provider value={contextValue}>
            <Outlet />
          </ProjectContext.Provider>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
