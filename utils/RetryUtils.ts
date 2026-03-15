/**
 * 重试工具类
 * 提供通用的重试功能
 */
export class RetryUtils {
	/**
	 * 带重试的异步操作执行器
	 * @param operation 要执行的操作
	 * @param maxRetries 最大重试次数（默认1次，即总共尝试2次）
	 * @param delay 重试间隔（毫秒，默认2000ms）
	 * @param onRetry 重试回调函数
	 * @returns 操作结果
	 */
	static async withRetry<T>(
		operation: () => Promise<T>,
		maxRetries: number = 1,
		delay: number = 2000,
		onRetry?: (attempt: number, error: Error) => void
	): Promise<T> {
		let lastError: Error;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await operation();
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				
				// 如果是最后一次尝试，抛出错误
				if (attempt === maxRetries) {
					throw lastError;
				}

				// 调用重试回调
				if (onRetry) {
					onRetry(attempt + 1, lastError);
				}

				// 等待后重试
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}

		// 这里理论上不会执行到，但为了类型安全
		throw lastError!;
	}

	/**
	 * 判断错误是否值得重试
	 * @param error 错误对象
	 * @returns 是否应该重试
	 */
	static shouldRetry(error: Error): boolean {
		const errorMessage = error.message.toLowerCase();
		
		// 网络相关错误
		if (errorMessage.includes('network') || 
			errorMessage.includes('timeout') || 
			errorMessage.includes('connection') ||
			errorMessage.includes('fetch')) {
			return true;
		}

		// HTTP状态码错误
		if (errorMessage.includes('500') || 
			errorMessage.includes('502') || 
			errorMessage.includes('503') || 
			errorMessage.includes('504')) {
			return true;
		}

		// 临时性错误
		if (errorMessage.includes('temporarily') || 
			errorMessage.includes('rate limit') ||
			errorMessage.includes('too many requests')) {
			return true;
		}

		// 默认不重试
		return false;
	}

	/**
	 * 智能重试：只对特定错误进行重试
	 * @param operation 要执行的操作
	 * @param maxRetries 最大重试次数
	 * @param delay 重试间隔
	 * @param onRetry 重试回调函数
	 * @returns 操作结果
	 */
	static async withSmartRetry<T>(
		operation: () => Promise<T>,
		maxRetries: number = 1,
		delay: number = 2000,
		onRetry?: (attempt: number, error: Error) => void
	): Promise<T> {
		let lastError: Error;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await operation();
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				
				// 如果是最后一次尝试，抛出错误
				if (attempt === maxRetries) {
					throw lastError;
				}

				// 检查是否应该重试
				if (!this.shouldRetry(lastError)) {
					throw lastError;
				}

				// 调用重试回调
				if (onRetry) {
					onRetry(attempt + 1, lastError);
				}

				// 等待后重试
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}

		// 这里理论上不会执行到，但为了类型安全
		throw lastError!;
	}
} 