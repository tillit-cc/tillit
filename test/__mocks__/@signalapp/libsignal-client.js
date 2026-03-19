// Mock for @signalapp/libsignal-client in E2E tests
// The real library is a native ESM addon that can't be transformed by Jest.
// In E2E tests, auth challenge verification is bypassed since we seed users directly.
module.exports = {
  PublicKey: {
    deserialize: jest.fn().mockReturnValue({
      verify: jest.fn().mockReturnValue(true),
    }),
  },
};
