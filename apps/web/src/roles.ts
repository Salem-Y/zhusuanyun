import type { RoleCode } from './api';

// 系统角色与项目角色使用同一套代码值，但含义相互独立：
// 系统角色决定账号能做什么（如系统管理员管账号与项目），项目角色决定在项目内承担的业务职责。
export const ROLE_LABELS: Record<RoleCode, string> = {
  COMPANY_MANAGEMENT: '公司管理层（已取消）',
  PROJECT_LEAD: '项目负责人',
  COST_ENGINEER: '造价员',
  FIELD_MANAGER: '项目其他管理人员',
  SYS_ADMIN: '系统管理员',
};

/** 项目内可授予的角色（项目角色不能授予系统管理员身份）。 */
export const PROJECT_ROLE_OPTIONS: Array<{ value: RoleCode; label: string }> = [
  { value: 'PROJECT_LEAD', label: '项目负责人' },
  { value: 'COST_ENGINEER', label: '造价员' },
  { value: 'FIELD_MANAGER', label: '项目其他管理人员' },
];

export const STATUS_LABELS: Record<string, string> = {
  ACTIVE: '在建',
  ARCHIVED: '已归档',
};
