import { VideoSummaryAPI } from '../api/VideoSummaryAPI';

/** Route the plugin's native request layer through the test's mocked global fetch. */
export function useFetchTransport() {
  const original = VideoSummaryAPI.transport;
  VideoSummaryAPI.transport = async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body as string | undefined,
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      headers: {},
      json: null,
      arrayBuffer: new ArrayBuffer(0),
    };
  };
  return () => {
    VideoSummaryAPI.transport = original;
  };
}
