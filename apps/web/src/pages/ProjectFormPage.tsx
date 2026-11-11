import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Result, Space, Typography } from 'antd';
import { api } from '../api';
import { useSession } from '../App';

interface FormValues {
  code: string;
  name: string;
  description?: string;
}

export default function ProjectFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const navigate = useNavigate();
  const session = useSession();
  const [form] = Form.useForm<FormValues>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 项目的创建与基础信息编辑仅系统管理员负责；编辑已并入「项目设置 · 基本信息」。
  if (session.user.role !== 'SYS_ADMIN' || mode !== 'create') {
    return (
      <Result
        status="403"
        title="无权执行该操作"
        subTitle="项目的创建与基础信息维护仅系统管理员可执行。"
        extra={
          <Button type="primary" onClick={() => navigate('/projects')}>
            返回项目列表
          </Button>
        }
      />
    );
  }

  const handleSubmit = async (values: FormValues) => {
    setLoading(true);
    setError(null);
    try {
      const created = await api.createProject({
        code: values.code.trim(),
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
      });
      navigate(`/projects/${created.id}/overview`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card size="small" title="新建项目">
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

      <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ maxWidth: 560 }}>
        <Form.Item
          name="code"
          label="项目编码"
          rules={[
            { required: true, message: '请输入项目编码' },
            { min: 2, max: 40, message: '长度 2-40 个字符' },
            { pattern: /^[A-Za-z0-9_-]+$/, message: '仅允许字母、数字、下划线和连字符' },
          ]}
          extra="项目编码需唯一，建议使用便于识别的编号规则"
        >
          <Input placeholder="例如 C1-CANTEEN" />
        </Form.Item>

        <Form.Item
          name="name"
          label="项目名称"
          rules={[
            { required: true, message: '请输入项目名称' },
            { min: 2, max: 80, message: '长度 2-80 个字符' },
          ]}
        >
          <Input placeholder="例如 新校区C-1#食堂项目" />
        </Form.Item>

        <Form.Item name="description" label="项目说明" rules={[{ max: 500, message: '最多 500 个字符' }]}>
          <Input.TextArea rows={4} placeholder="简要说明项目范围、用途等" />
        </Form.Item>

        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={loading}>
              保存
            </Button>
            <Button onClick={() => navigate('/projects')}>取消</Button>
          </Space>
        </Form.Item>
      </Form>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        说明：创建后请在「项目设置 · 成员与权限」中为项目成员授权；系统管理员不因创建项目自动获得经营数据权限。
      </Typography.Text>
    </Card>
  );
}
