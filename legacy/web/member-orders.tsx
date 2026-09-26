import { useState } from "react";
import { Link } from "react-router-dom";
import { money, shortDate } from "./api";
import { Empty, ErrorBox, Field, Loading, useData } from "./components";
import { HtmlContent } from "./rich-text";

type Order = {
  id: string;
  number: number;
  created_at: string;
  product_name: string;
  variant_name: string;
  quantity: number;
  status: string;
  shipped_at: string | null;
  invoice_id: string;
  invoice_number: number;
  total_cents: number;
  balance_cents: number;
};
export function MemberOrders({ org }: { org: string }) {
  const { data, loading, error } = useData<Order[]>(
    `/public/sites/${encodeURIComponent(org)}/store/orders`,
    [],
  );
  const [status, setStatus] = useState("");
  const rows = data.filter((order) => !status || order.status === status);
  return (
    <section className="member-orders">
      <h1>My orders</h1>
      <p>Orders you purchased, including purchases for your family.</p>
      <Field label="Order status">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All orders</option>
          {["Open", "Closed", "Canceled"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </Field>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : (
        !error &&
        (!rows.length ? (
          <Empty>No orders match this selection.</Empty>
        ) : (
          rows.map((order) => (
            <article className="member-order" key={order.id}>
              <h2>Order #{order.number}</h2>
              <p>
                {shortDate(order.created_at)} · {order.status}
                {order.shipped_at
                  ? ` · Shipped ${shortDate(order.shipped_at)}`
                  : ""}
              </p>
              <h3>{order.product_name}</h3>
              {order.variant_name && <p>{order.variant_name}</p>}
              <p>Quantity: {order.quantity}</p>
              <p>
                Total: <strong>{money(order.total_cents)}</strong> · Amount due:{" "}
                <strong>{money(order.balance_cents)}</strong>
              </p>
              <Link to={`/site/${org}/account/invoice?id=${order.invoice_id}`}>
                View invoice #{order.invoice_number}
              </Link>
              <OrderDetails org={org} id={order.id}/>
            </article>
          ))
        ))
      )}
    </section>
  );
}

function OrderDetails({org,id}:{org:string;id:string}) {
  const [open,setOpen] = useState(false);
  return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary>Purchase details</summary>{open && <OrderDetailsContent org={org} id={id}/>}</details>;
}
function OrderDetailsContent({org,id}:{org:string;id:string}) {
  const {data,loading,error} = useData<{receipt_message:string;shipping_address:Record<string,string>|null;subtotal_cents:number;tax_cents:number;shipping_cents:number}|null>(`/public/sites/${encodeURIComponent(org)}/store/orders/${encodeURIComponent(id)}`,null);
  if(loading) return <Loading/>;
  if(error) return <ErrorBox error={error}/>;
  if(!data) return null;
  return <div><p>Items: {money(data.subtotal_cents)} · Tax: {money(data.tax_cents)} · Shipping: {money(data.shipping_cents)}</p>
    {data.receipt_message && <><h3>Original purchase instructions</h3><HtmlContent html={data.receipt_message}/></>}
    {data.shipping_address && <><h3>Shipping address</h3><address>{['name','address','city','state','postal_code','country'].map(key=><div key={key}>{data.shipping_address![key]}</div>)}</address></>}
  </div>;
}
