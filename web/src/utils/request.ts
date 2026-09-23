import axios, { type AxiosInstance } from "axios";

function resolveBaseUrl(value: string | undefined): string {
  const baseUrl = value?.trim();
  if (!baseUrl) return "";
  if (/^https?:\/\//i.test(baseUrl) || baseUrl.startsWith("//")) {
    return baseUrl.replace(/\/$/, "");
  }
  return `//${baseUrl.replace(/^\/+|\/$/g, "")}`;
}

export function createRequest(baseURL = import.meta.env.VITE_GATEWAY_HTTP_URL): AxiosInstance {
  return axios.create({
    baseURL: resolveBaseUrl(baseURL),
    headers: { "Content-Type": "application/json" },
  });
}

const request = createRequest();

export default request;