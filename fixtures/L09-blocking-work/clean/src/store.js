// An in-memory store, standing in for the database.
const users = new Map();
const orders = [];

export const store = {
  async findUser(email) { return users.get(email) ?? null; },
  async saveUser(user) { users.set(user.email, user); return user; },
  async allOrders() { return orders; },
};
