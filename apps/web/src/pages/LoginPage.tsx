import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Typography, App as AntApp } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { api, type SessionInfo } from '../api';

export default function LoginPage({ onLoggedIn }: { onLoggedIn: (s: SessionInfo) => void }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { message } = AntApp.useApp();

  const handleSubmit = async (values: { username: string; password: string }) => {
    setLoading(true);
    setError(null);
    try {
      const session = await api.login(values.username, values.password);
      onLoggedIn(session);
      message.success('登录成功');
      navigate('/projects');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(180deg, #f4f6f9 0%, #e8edf5 100%)',
      }}
    >
      <Card style={{ width: 400, boxShadow: '0 6px 24px rgba(31,53,82,.08)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Typography.Title level={3} style={{ marginBottom: 4, color: '#1f3552' }}>
            筑算云
          </Typography.Title>
          <Typography.Text type="secondary">工程项目经营与成本分析平台</Typography.Text>
        </div>

        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

        <Form layout="vertical" onFinish={handleSubmit} requiredMark={false}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="请输入用户名" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="请输入密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>

        <Typography.Paragraph type="secondary" style={{ marginTop: 20, marginBottom: 0, fontSize: 12 }}>
          本平台不提供默认口令。演示环境账号由初始化脚本生成，登录凭据保存在本机
          <code>.secrets/demo-passwords.txt</code>，请勿提交到代码仓库或发送给他人。
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
