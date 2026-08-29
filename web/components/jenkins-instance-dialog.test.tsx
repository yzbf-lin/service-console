import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { JenkinsInstanceDialog } from "@/components/jenkins-instance-dialog";
import type { JenkinsInstance } from "@/lib/types";

const source: JenkinsInstance = {
  id: "instance-a",
  name: "测试 Jenkins",
  baseUrl: "https://jenkins.example.com",
  username: "builder",
  caBundle: "C:\\certs\\company-ca.pem",
  enabled: true,
  requestTimeout: 20,
  tokenPresent: true,
  credentialError: null,
};

describe("JenkinsInstanceDialog", () => {
  it("never echoes a stored token and omits an empty token when editing", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <JenkinsInstanceDialog
        open
        mode="edit"
        source={source}
        submitting={false}
        testing={false}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        onTest={vi.fn()}
      />,
    );

    const token = screen.getByLabelText("API Token") as HTMLInputElement;
    expect(token.value).toBe("");
    expect(token.placeholder).toBe("留空保持不变");
    expect(screen.queryByDisplayValue(/token/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("token");
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      base_url: "https://jenkins.example.com",
      ca_bundle: "C:\\certs\\company-ca.pem",
      request_timeout: 20,
    });
  });

  it("requires a fresh token for a copied instance", () => {
    render(
      <JenkinsInstanceDialog
        open
        mode="copy"
        source={source}
        submitting={false}
        testing={false}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onTest={null}
      />,
    );

    expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe("测试 Jenkins 副本");
    expect((screen.getByLabelText("API Token") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("API Token") as HTMLInputElement).required).toBe(true);
    expect(screen.getByText("复制不会带出原实例 Token，请为副本重新填写。")).toBeTruthy();
  });

  it("submits a newly entered token without changing the CA path contract", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <JenkinsInstanceDialog
        open
        mode="create"
        source={null}
        submitting={false}
        testing={false}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        onTest={null}
      />,
    );

    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "生产 Jenkins" } });
    fireEvent.change(screen.getByLabelText("Jenkins 地址"), { target: { value: "https://prod.example.com/" } });
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "ci-user" } });
    fireEvent.change(screen.getByLabelText("API Token"), { target: { value: "new-secret" } });
    fireEvent.change(screen.getByLabelText("CA 证书文件路径（可选）"), { target: { value: "/etc/ssl/company.pem" } });
    fireEvent.click(screen.getByRole("button", { name: "添加实例" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: "生产 Jenkins",
      base_url: "https://prod.example.com",
      username: "ci-user",
      token: "new-secret",
      ca_bundle: "/etc/ssl/company.pem",
    })));
  });

  it("explains how to create a token and builds version-compatible help links", () => {
    render(
      <JenkinsInstanceDialog
        open
        mode="create"
        source={null}
        submitting={false}
        testing={false}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onTest={null}
      />,
    );

    expect(screen.getByText("如何获取 API Token")).toBeTruthy();
    fireEvent.click(screen.getByText("如何获取 API Token"));
    expect(screen.getByText("先填写有效的 Jenkins HTTP(S) 地址，即可显示个人配置快捷入口。")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Jenkins 地址"), {
      target: { value: "http://10.0.0.231:8082/jenkins/" },
    });

    expect(screen.getByRole("link", { name: /打开 Security/ }).getAttribute("href"))
      .toBe("http://10.0.0.231:8082/jenkins/me/security");
    expect(screen.getByRole("link", { name: /旧版 Configure/ }).getAttribute("href"))
      .toBe("http://10.0.0.231:8082/jenkins/me/configure");
    expect(screen.getByText(/Security 返回 404 时改用 Configure/)).toBeTruthy();
  });
});
