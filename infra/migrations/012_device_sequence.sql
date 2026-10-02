-- Device-local signed sequence numbers are kept beside the original signed body.
-- Older events remain null; a new event never rewrites earlier history.
alter table led.event add column device_seq bigint
  check (device_seq is null or device_seq > 0);

create index event_device_seq_idx on led.event (actor_device, device_seq desc)
  where device_seq is not null;
