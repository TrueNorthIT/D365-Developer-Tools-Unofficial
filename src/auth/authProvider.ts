export interface AuthProvider {
    getAccessToken(): Promise<string>;
    dispose(): void;
}
