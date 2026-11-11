import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  App as AntApp,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { api, type ProjectMemberInfo, type RoleCode, type UnitProject, type UserAccount } from '../api';
import { PROJECT_ROLE_OPTIONS, ROLE_LABELS, STATUS_LABELS } from '../roles';
import { useSession } from '../App';
import { useProject } from '../project/ProjectContext';

interface BasicFormValues {
  code: string;
  name: string;
  description?: string;
  status: 'ACTIVE' | 'ARCHIVED';
}

function BasicInfoTab({ isSysAdmin }: { isSysAdmin: boolean }) {
  const { project, reload } = useProject();
  const [form] = Form.useForm<BasicFormValues>();
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<BasicFormValues | null>(null);
  const { message } = AntApp.useApp();

  useEffect(() => {
    form.setFieldsValue({
      code: project.code,
      name: project.name,
      description: project.description ?? '',
      status: project.status,
    });
  }, [form, project.code, project.name, project.description, project.status]);

  if (!isSysAdmin) {
    return (
      <>
        <Descriptions column={1} size="small" bordered style={{ maxWidth: 640 }}>
          <Descriptions.Item label="项目编码">{project.code}</Descriptions.Item>
          <Descriptions.Item label="项目名称">{project.name}</Descriptions.Item>
          <Descriptions.Item label="项目说明">{project.description || '未填写'}</Descriptions.Item>
          <Descriptions.Item label="项目状态">{STATUS_LABELS[project.status] ?? project.status}</Descriptions.Item>
        </Descriptions>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          项目基础信息由系统管理员维护，当前账号为只读查看。
        </Typography.Text>
      </>
    );
  }

  const submit = async (values: BasicFormValues) => {
    setSaving(true);
    try {
      await api.updateProject(project.id, {
        code: values.code.trim().toUpperCase(),
        name: values.name.trim(),
        description: values.description?.trim() ?? '',
        status: values.status,
        // 携带读取时的原编码，编码已被他人改动时后端拒绝，避免静默覆盖。
        expectedCode: project.code,
      });
      message.success('项目信息已保存');
      setPending(null);
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Form
        form={form}
        layout="vertical"
        style={{ maxWidth: 560 }}
        onFinish={(values) => {
          const newCode = values.code.trim().toUpperCase();
          // 编码变更需二次确认（展示原编码与新编码）；其他字段可直接保存。
          if (newCode !== project.code) {
            setPending(values);
          } else {
            void submit(values);
          }
        }}
      >
        <Form.Item
          label="项目编码"
          name="code"
          rules={[
            { required: true, message: '请输入项目编码' },
            { min: 2, max: 40, message: '长度 2-40 个字符' },
            { pattern: /^[A-Za-z0-9_-]+$/, message: '仅允许字母、数字、下划线和连字符' },
          ]}
          extra="保存时将去除首尾空格并统一转为大写；编码查重不区分大小写；仅字母、数字、下划线和连字符，长度 2-40。"
        >
          <Input />
        </Form.Item>
        <Form.Item
          name="name"
          label="项目名称"
          rules={[
            { required: true, message: '请输入项目名称' },
            { min: 2, max: 80, message: '长度 2-80 个字符' },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item name="description" label="项目说明" rules={[{ max: 500, message: '最多 500 个字符' }]}>
          <Input.TextArea rows={4} />
        </Form.Item>
        <Form.Item name="status" label="项目状态" extra="归档后项目保留全部历史数据，仅不再作为在建项目管理">
          <Select
            options={[
              { value: 'ACTIVE', label: '在建' },
              { value: 'ARCHIVED', label: '已归档' },
            ]}
          />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>
          保存
        </Button>
      </Form>

      <Modal
        title="确认修改项目编码"
        open={!!pending}
        onOk={() => pending && submit(pending)}
        onCancel={() => setPending(null)}
        okText="确认保存"
        cancelText="取消"
        confirmLoading={saving}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="原编码">{project.code}</Descriptions.Item>
            <Descriptions.Item label="新编码">
              <Typography.Text strong>{pending?.code.trim().toUpperCase()}</Typography.Text>
            </Descriptions.Item>
          </Descriptions>
          <Alert
            type="info"
            showIcon
            message="项目的内部关联使用稳定的项目ID"
            description="修改编码不会中断项目成员、已有记录与审计；历史审计与报告快照保留修改前的编码。"
          />
        </Space>
      </Modal>
    </>
  );
}

function MembersTab({ isSysAdmin }: { isSysAdmin: boolean }) {
  const { project, members, reload } = useProject();
  const { message } = AntApp.useApp();
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProjectMemberInfo | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | undefined>();
  const [selectedRole, setSelectedRole] = useState<RoleCode | undefined>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isSysAdmin) return;
    api.listUsers().then(setUsers).catch(() => setUsers([]));
  }, [isSysAdmin]);

  const memberIds = new Set(members.map((m) => m.userId));
  const candidates = users.filter((u) => u.isActive && !memberIds.has(u.id));

  const handleAdd = async () => {
    if (!selectedUser || !selectedRole) return;
    setSubmitting(true);
    try {
      await api.addMember(project.id, { userId: selectedUser, roleCode: selectedRole });
      message.success('成员已添加');
      setAddOpen(false);
      setSelectedUser(undefined);
      setSelectedRole(undefined);
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateRole = async () => {
    if (!editTarget || !selectedRole) return;
    setSubmitting(true);
    try {
      await api.updateMember(project.id, editTarget.userId, { roleCode: selectedRole });
      message.success('项目角色已更新');
      setEditTarget(null);
      setSelectedRole(undefined);
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (member: ProjectMemberInfo) => {
    try {
      await api.removeMember(project.id, member.userId);
      message.success(`已将 ${member.displayName} 移出项目（账号与历史记录保留）`);
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <>
      {isSysAdmin && (
        <Space style={{ marginBottom: 12 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
            添加成员
          </Button>
        </Space>
      )}
      <Table
        size="small"
        rowKey="userId"
        pagination={false}
        dataSource={members}
        locale={{ emptyText: '该项目暂无成员授权' }}
        columns={[
          { title: '姓名', dataIndex: 'displayName' },
          { title: '登录名', dataIndex: 'username' },
          {
            title: '系统角色',
            dataIndex: 'systemRole',
            render: (role: RoleCode) => ROLE_LABELS[role] ?? role,
          },
          {
            title: '项目角色',
            dataIndex: 'roleCode',
            render: (role: RoleCode) => <Tag color="blue">{ROLE_LABELS[role] ?? role}</Tag>,
          },
          {
            title: '账号状态',
            dataIndex: 'userActive',
            width: 90,
            render: (active: boolean) => (active ? '启用' : <Tag>已停用</Tag>),
          },
          {
            title: '授权时间',
            dataIndex: 'grantedAt',
            width: 160,
            render: (value: string) => new Date(value).toLocaleString('zh-CN'),
          },
          ...(isSysAdmin
            ? [
                {
                  title: '操作',
                  width: 170,
                  render: (_: unknown, record: ProjectMemberInfo) => (
                    <Space>
                      <Button
                        size="small"
                        onClick={() => {
                          setEditTarget(record);
                          setSelectedRole(record.roleCode);
                        }}
                      >
                        修改角色
                      </Button>
                      <Popconfirm
                        title="移出项目成员"
                        description="仅移出本项目授权，不删除账号，其历史业务与操作记录保留。"
                        okText="移出"
                        cancelText="取消"
                        onConfirm={() => handleRemove(record)}
                      >
                        <Button size="small" danger>
                          移出
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        说明：项目成员与权限由系统管理员维护；项目角色仅用于项目内业务职责，不能授予系统管理员身份；
        成员变化会记录操作人、时间与内容。后续有待办事项时，移出成员将提示交接（待办功能未开放）。
      </Typography.Text>

      <Modal
        title="添加项目成员"
        open={addOpen}
        onOk={handleAdd}
        onCancel={() => setAddOpen(false)}
        okText="添加"
        cancelText="取消"
        confirmLoading={submitting}
        okButtonProps={{ disabled: !selectedUser || !selectedRole }}
        destroyOnHidden
      >
        <Form layout="vertical">
          <Form.Item label="选择账号" required>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="从已有账号中选择"
              value={selectedUser}
              onChange={setSelectedUser}
              options={candidates.map((u) => ({
                value: u.id,
                label: `${u.displayName}（${u.username} · ${ROLE_LABELS[u.role]}）`,
              }))}
              notFoundContent="暂无可添加的启用账号"
            />
          </Form.Item>
          <Form.Item label="项目角色" required extra="项目角色决定其在项目内的业务职责，与账号的系统角色相互独立">
            <Select
              placeholder="选择项目角色"
              value={selectedRole}
              onChange={setSelectedRole}
              options={PROJECT_ROLE_OPTIONS}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`修改项目角色 · ${editTarget?.displayName ?? ''}`}
        open={!!editTarget}
        onOk={handleUpdateRole}
        onCancel={() => setEditTarget(null)}
        okText="保存"
        cancelText="取消"
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form layout="vertical">
          <Form.Item label="项目角色" required>
            <Select value={selectedRole} onChange={setSelectedRole} options={PROJECT_ROLE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

/** 删除项目：仅系统管理员可见；需输入项目编码确认，且后端会再次校验依赖与权限。 */
function DangerTab() {
  const { project } = useProject();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);

  const matched = typed.trim().toUpperCase() === project.code.toUpperCase();

  const handleDelete = async () => {
    if (!matched || deleting) return;
    setDeleting(true);
    try {
      await api.deleteProject(project.id, typed.trim());
      message.success('项目已删除');
      // 删除成功后回到项目列表，列表会重新加载，旧的选中项目不再保留。
      navigate('/projects');
    } catch (e) {
      message.error((e as Error).message);
      setDeleting(false);
    }
  };

  return (
    <>
      <Space direction="vertical" size={12} style={{ maxWidth: 640 }}>
        <Typography.Text>
          仅用于删除误建、尚未发生正式业务的项目。删除后项目及其成员授权一并移除，且<strong>不可恢复</strong>。
        </Typography.Text>
        <Alert
          type="warning"
          showIcon
          message="已归档项目无需删除"
          description="如项目已发生成本、收入、审批等业务，请使用归档而不是删除；系统会在删除时重新检查依赖并拒绝。"
        />
        <Button danger icon={<DeleteOutlined />} onClick={() => setOpen(true)}>
          删除项目
        </Button>
      </Space>

      <Modal
        title="确认删除项目"
        open={open}
        onOk={handleDelete}
        onCancel={() => {
          if (!deleting) setOpen(false);
        }}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: !matched }}
        confirmLoading={deleting}
        maskClosable={false}
        closable={!deleting}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="项目名称">{project.name}</Descriptions.Item>
            <Descriptions.Item label="项目编码">{project.code}</Descriptions.Item>
          </Descriptions>
          <Alert
            type="error"
            showIcon
            message="删除后不可恢复"
            description="项目对象与其成员授权将被移除；已发生的审计记录会保留。如项目存在需保留的业务记录，系统将拒绝删除。"
          />
          <div>
            <Typography.Text>请输入项目编码以确认：</Typography.Text>
            <Input
              style={{ marginTop: 6 }}
              placeholder={project.code}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={deleting}
            />
          </div>
        </Space>
      </Modal>
    </>
  );
}

/** 核算口径说明：由项目负责人维护，成本工作台顶部展示。 */
function CaliberTab() {
  const { project, members, reload } = useProject();
  const session = useSession();
  const { message } = AntApp.useApp();
  const myRole = members.find((m) => m.userId === session.user.id)?.roleCode ?? null;
  const canEdit = myRole === 'PROJECT_LEAD' && project.status === 'ACTIVE';
  const [note, setNote] = useState(project.costCaliberNote ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setNote(project.costCaliberNote ?? '');
  }, [project.costCaliberNote]);

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Alert
        type="info"
        showIcon
        message="核算口径说明随成本汇总展示：成本不含可抵扣进项税，不可抵扣税额按规则计入成本。"
      />
      <Input.TextArea
        rows={5}
        maxLength={1000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={!canEdit}
        placeholder="填写本项目的成本核算口径说明（最多 1000 字）"
      />
      {canEdit ? (
        <Button
          type="primary"
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await api.saveCaliber(project.id, note);
              message.success('核算口径说明已保存');
              await reload();
            } catch (e) {
              message.error((e as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          保存
        </Button>
      ) : (
        <Typography.Text type="secondary">仅项目负责人可维护核算口径说明。</Typography.Text>
      )}
    </Space>
  );
}

/** 单项工程管理：清单项与成本明细的维度（如 1#楼、2#楼、地下室）。 */
function UnitProjectsTab() {
  const { project, members } = useProject();
  const session = useSession();
  const { message } = AntApp.useApp();
  const myRole = members.find((m) => m.userId === session.user.id)?.roleCode ?? null;
  const canEdit = (myRole === 'PROJECT_LEAD' || myRole === 'COST_ENGINEER') && project.status === 'ACTIVE';

  const [units, setUnits] = useState<UnitProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [editTarget, setEditTarget] = useState<UnitProject | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.listUnitProjects(project.id);
      setUnits(data.units);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const openCreate = () => {
    setEditTarget(null);
    form.setFieldsValue({ name: '', sortOrder: units.length });
    setFormOpen(true);
  };

  const openEdit = (unit: UnitProject) => {
    setEditTarget(unit);
    form.setFieldsValue({ name: unit.name, sortOrder: unit.sortOrder });
    setFormOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editTarget) {
        await api.updateUnitProject(project.id, editTarget.id, {
          name: values.name.trim(),
          sortOrder: Number(values.sortOrder ?? 0),
        });
        message.success('单项工程已更新');
      } else {
        await api.createUnitProject(project.id, {
          name: values.name.trim(),
          sortOrder: Number(values.sortOrder ?? 0),
        });
        message.success('单项工程已新增');
      }
      setFormOpen(false);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (unit: UnitProject) => {
    try {
      await api.updateUnitProject(project.id, unit.id, { isActive: !unit.isActive });
      message.success(unit.isActive ? '已停用，后续下拉不再可选' : '已启用');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = async (unit: UnitProject) => {
    try {
      await api.deleteUnitProject(project.id, unit.id);
      message.success('单项工程已删除');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="单项工程用于拆分收入与成本维度（如 1#楼、2#楼、地下室）"
        description="清单项必须归属一个单项工程；成本明细优先自动带出清单项所属单项工程，未关联清单项时必须手动选择。已被业务数据引用的单项工程只能停用，不能删除。"
      />
      {canEdit && (
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增单项工程
        </Button>
      )}
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        pagination={false}
        dataSource={units}
        locale={{ emptyText: '尚未维护单项工程，请先新增' }}
        columns={[
          { title: '单项工程名称', dataIndex: 'name' },
          { title: '排序', dataIndex: 'sortOrder', width: 80 },
          {
            title: '状态',
            dataIndex: 'isActive',
            width: 90,
            render: (active: boolean) => (active ? <Tag color="green">启用</Tag> : <Tag>已停用</Tag>),
          },
          { title: '关联清单项', dataIndex: 'boqItemCount', width: 100 },
          {
            title: '成本明细',
            width: 100,
            render: (_: unknown, r: UnitProject) => (r.targetLineCount ?? 0) + (r.actualEntryCount ?? 0),
          },
          ...(canEdit
            ? [
                {
                  title: '操作',
                  width: 200,
                  render: (_: unknown, r: UnitProject) => (
                    <Space>
                      <Button size="small" onClick={() => openEdit(r)}>
                        编辑
                      </Button>
                      <Button size="small" onClick={() => toggleActive(r)}>
                        {r.isActive ? '停用' : '启用'}
                      </Button>
                      <Popconfirm
                        title="删除单项工程"
                        description="仅未被业务数据引用时可删除；被引用时请改用停用。"
                        okText="删除"
                        cancelText="取消"
                        onConfirm={() => remove(r)}
                      >
                        <Button size="small" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />

      <Modal
        title={editTarget ? '编辑单项工程' : '新增单项工程'}
        open={formOpen}
        onOk={save}
        onCancel={() => setFormOpen(false)}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请填写单项工程名称' }, { max: 60 }]}
          >
            <Input placeholder="如 1#楼、2#楼、地下室" />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序（数字越小越靠前）">
            <Input type="number" min={0} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

/** 收入建安税率：仅用于合同清单录入时带出默认值，成本模块单独录入。 */
function RevenueTaxTab() {
  const { project, members, reload } = useProject();
  const session = useSession();
  const { message } = AntApp.useApp();
  const myRole = members.find((m) => m.userId === session.user.id)?.roleCode ?? null;
  const canEdit = myRole === 'PROJECT_LEAD' && project.status === 'ACTIVE';
  const [rate, setRate] = useState<number>(Number(project.revenueTaxRate ?? 9));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRate(Number(project.revenueTaxRate ?? 9));
  }, [project.revenueTaxRate]);

  return (
    <Space direction="vertical" size={12} style={{ maxWidth: 560 }}>
      <Alert
        type="info"
        showIcon
        message="收入建安税率仅作用于「合同清单」录入"
        description="新增/编辑清单项时自动带出该税率并据此反算含税/不含税单价；成本明细不使用此全局税率，需在每张单据中单独录入。"
      />
      <Form layout="vertical">
        <Form.Item label="默认收入建安税率（%）" extra="范围 0-100，最多 2 位小数，例如 9 表示 9%">
          <Input
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={rate}
            disabled={!canEdit}
            onChange={(e) => setRate(Number(e.target.value))}
            suffix="%"
          />
        </Form.Item>
      </Form>
      {canEdit ? (
        <Button
          type="primary"
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await api.saveRevenueTaxRate(project.id, String(rate));
              message.success('收入建安税率已保存');
              await reload();
            } catch (e) {
              message.error((e as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          保存
        </Button>
      ) : (
        <Typography.Text type="secondary">仅项目负责人可设置收入建安税率。</Typography.Text>
      )}
    </Space>
  );
}

export default function ProjectSettingsPage() {
  const session = useSession();
  const isSysAdmin = session.user.role === 'SYS_ADMIN';

  return (
    <Card size="small" title="项目设置">
      {!isSysAdmin && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message="项目设置由系统管理员维护"
          description="你可以查看项目基础信息与成员授权情况；如需调整，请联系系统管理员。"
        />
      )}
      <Tabs
        items={[
          { key: 'basic', label: '基本信息', children: <BasicInfoTab isSysAdmin={isSysAdmin} /> },
          { key: 'members', label: '成员与权限', children: <MembersTab isSysAdmin={isSysAdmin} /> },
          { key: 'caliber', label: '核算口径', children: <CaliberTab /> },
          { key: 'units', label: '单项工程', children: <UnitProjectsTab /> },
          { key: 'revenue-tax', label: '收入建安税率', children: <RevenueTaxTab /> },
          ...(isSysAdmin
            ? [{ key: 'danger', label: '危险操作', children: <DangerTab /> }]
            : []),
        ]}
      />
    </Card>
  );
}
