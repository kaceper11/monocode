import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { prepareAttachments } from "./attachments";
import type { Attachment } from "./session";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("transfers explicit native attachments and never sends Windows or another distro's paths", async () => {
  const cwd = "//wsl.localhost/Ubuntu/home/me/repo";
  const file: Attachment = { id: "a", name: "Zażółć.txt", path: "C:/Users/me/Zażółć.txt", mimeType: "text/plain", kind: "file", size: 5 };
  vi.mocked(invoke).mockImplementation(async (command) => command === "read_file_base64" ? "aGVsbG8=" : "//wsl.localhost/Ubuntu/tmp/Zażółć.txt");
  expect(await prepareAttachments([file], cwd)).toEqual([{ ...file, path: "/tmp/Zażółć.txt" }]);
  expect(invoke).toHaveBeenCalledWith("write_attachment", { name: file.name, data: "aGVsbG8=", cwd });
  vi.mocked(invoke).mockClear();
  const linux = { ...file, path: "//wsl.localhost/Ubuntu/home/me/Case.txt" };
  expect(await prepareAttachments([linux], cwd)).toEqual([{ ...linux, path: "/home/me/Case.txt" }]);
  const image = { ...file, mimeType: "image/png", data: "aGVsbG8=" };
  expect((await prepareAttachments([image], cwd))[0].path).toBeUndefined();
  await expect(prepareAttachments([{ ...file, path: "//wsl.localhost/Debian/home/me/file" }], cwd)).rejects.toThrow("another WSL distribution");
  await expect(prepareAttachments([{ ...file, size: 21 * 1024 * 1024 }], cwd)).rejects.toThrow("larger than 20 MiB");
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockRejectedValue(new Error("Distribution stopped"));
  await expect(prepareAttachments([file], cwd)).rejects.toThrow("Distribution stopped");
});
