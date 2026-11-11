import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dropdown, Layout, Select, Space, Tag } from 'antd';
import {
  AppstoreOutlined,
  ControlOutlined,
  LogoutOutlined,
  RollbackOutlined,
  SwapOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api, type Project } from '../api';
import { ROLE_LABELS } from '../roles';
import { useSession } from '../App';

interface AppHeaderProps {
  onLogout: () => void;
  /** 处于项目空间时传入当前项目；项目列表等页面传空。 */
  project?: { id: string; code: string; name: string } | null;
}

export default function AppHeader({ onLogout, project }: AppHeaderProps) {
  const session = useSession();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);

  // 仅项目空间需要“切换项目”列表；列表只包含当前用户被授权的项目（后端控制）。
  useEffect(() => {
    if (!project) return;
    api
      .listProjects()
      .then((r) => setProjects(r.data))
      .catch(() => setProjects([]));
  }, [project]);

  const isSysAdmin = session.user.role === 'SYS_ADMIN';

  return (
    <Layout.Header
      style={{
        background: '#fff',
        borderBottom: '1px solid #e8ecf2',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 24px',
        height: 56,
        lineHeight: '56px',
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      <Space
        size={10}
        style={{ cursor: 'pointer' }}
        onClick={() => navigate('/projects')}
      >
        <AppstoreOutlined style={{ color: '#2f5c9e', fontSize: 20 }} />
        <span style={{ fontWeight: 600, fontSize: 16, color: '#1f3552' }}>筑算云</span>
        <span className="muted" style={{ fontSize: 13 }}>
          AI工程项目经营与成本分析平台
        </span>
      </Space>

      {project && (
        <Space size={8} style={{ marginLeft: 12 }}>
          <span className="muted" style={{ fontSize: 13 }}>
            当前项目
          </span>
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            {project.code} · {project.name}
          </Tag>
        </Space>
      )}

      <div style={{ flex: 1 }} />

      {project && (
        <Space size={8}>
          <Select
            size="small"
            placeholder="切换项目"
            suffixIcon={<SwapOutlined />}
            style={{ width: 240 }}
            showSearch
            optionFilterProp="label"
            value={project.id}
            options={projects.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))}
            onChange={(value) => {
              // 切换项目后由项目布局重新加载并重新校验权限，不保留上一项目数据。
              if (value !== project.id) navigate(`/projects/${value}/overview`);
            }}
          />
          <Button size="small" icon={<RollbackOutlined />} onClick={() => navigate('/projects')}>
            返回项目列表
          </Button>
        </Space>
      )}

      <Dropdown
        menu={{
          items: [
            ...(isSysAdmin
              ? [
                  {
                    key: 'system',
                    icon: <ControlOutlined />,
                    label: '系统设置',
                    onClick: () =>
                      navigate(project ? `/settings/system?fromProject=${project.id}` : '/settings/system'),
                  },
                ]
              : []),
            { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: onLogout },
          ],
        }}
      >
        <Space style={{ cursor: 'pointer' }}>
          <UserOutlined />
          <span>{session.user.displayName}</span>
          <Tag color="blue">{ROLE_LABELS[session.user.role]}</Tag>
        </Space>
      </Dropdown>
    </Layout.Header>
  );
}
