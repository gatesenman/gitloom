// one small, realistic source file per supported grammar (used by tests/vizParse.test.ts)
export const SNIPPETS: Record<string, { path: string; src: string }> = {
  typescript: { path: 'src/svc/order.ts', src: `import { save } from '../db/store'
import type { Order } from './model'
export type OrderStatus = 'new' | 'paid' | 'shipped'
export class OrderService extends Base implements Svc {
  private n = 0
  pay(o: Order) {
    if (o.status !== 'new') throw new Error('bad')
    o.status = 'paid'
    save(o)
    this.notify(o)
  }
  notify(o: Order) { emit('order.paid', o) }
}
export function total(xs: Order[]) { let t = 0; for (const x of xs) t += x.amount; return t }
` },
  tsx: { path: 'src/ui/Page.tsx', src: `import React from 'react'
import { total } from '../svc/order'
export function Page({ xs }: { xs: number[] }) {
  const t = total(xs)
  return <div onClick={() => load()}>{t}</div>
}
` },
  javascript: { path: 'lib/util.js', src: `const fs = require('fs')
import path from 'path'
export function read(p) { try { return fs.readFileSync(path.join('a', p), 'utf8') } catch (e) { return null } }
class Cache { get(k) { return this.m.get(k) } }
` },
  python: { path: 'pkg/users.py', src: `from enum import Enum
from .db import session
import logging

class Status(Enum):
    ACTIVE = 1
    DELETED = 2

class User:
    def __init__(self, name):
        self.name = name

class Admin(User):
    def ban(self, other):
        if other.status == Status.ACTIVE:
            other.status = Status.DELETED
            session.save(other)
        logging.info("ban")
` },
  java: { path: 'src/main/java/com/shop/PaymentGateway.java', src: `package com.shop;
import java.util.List;
import com.shop.model.Order;
public class PaymentGateway implements Gateway {
  private final OrderRepo repo;
  public boolean pay(Order o) {
    if (o.getStatus() == Status.NEW) { o.setStatus(Status.PAID); repo.save(o); return true; }
    return false;
  }
}
enum Status { NEW, PAID, FAILED }
` },
  go: { path: 'internal/api/handler.go', src: `package api
import (
  "fmt"
  "shop/internal/store"
)
type Handler struct { db *store.DB }
func (h *Handler) Get(id string) (string, error) {
  if id == "" { return "", fmt.Errorf("empty") }
  return h.db.Find(id), nil
}
func New() *Handler { return &Handler{} }
` },
  rust: { path: 'src/lib.rs', src: `use std::collections::HashMap;
mod store;
pub struct Cache { m: HashMap<String, String> }
pub enum State { Idle, Busy }
impl Cache {
    pub fn get(&self, k: &str) -> Option<&String> { if k.is_empty() { return None } self.m.get(k) }
}
pub fn make() -> Cache { Cache { m: HashMap::new() } }
` },
  csharp: { path: 'src/Orders/OrderController.cs', src: `using System;
using Shop.Services;
namespace Shop.Orders {
  public class OrderController : ControllerBase {
    private readonly IOrderService svc;
    public string Get(int id) { if (id < 0) throw new ArgumentException(); return svc.Find(id); }
  }
  public enum Status { New, Paid }
}
` },
  kotlin: { path: 'app/src/main/kotlin/Repo.kt', src: `package app
import app.net.Api
class Repo(private val api: Api) : Base() {
    fun load(id: String): String {
        if (id.isEmpty()) return ""
        return api.fetch(id)
    }
}
fun helper() = Repo(Api())
` }
}
