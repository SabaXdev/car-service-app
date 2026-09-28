namespace com.carservice;

using { cuid, managed } from '@sap/cds/common';

type ServiceOrderStatus : String enum {
  OPEN;
  IN_PROGRESS;
  COMPLETED;
  CANCELLED;
}

type ServiceItemType : String enum {
  LABOR;
  PART;
}

type MechanicStatus : String enum {
  AVAILABLE;
  BUSY;
}

entity Customers : cuid, managed {
  name            : String(100) not null;
  phone           : String(30);
  email           : String(241) not null;
  isFleetCustomer : Boolean default false not null;

  vehicles      : Association to many Vehicles
                    on vehicles.customer = $self;
  serviceOrders : Association to many ServiceOrders
                    on serviceOrders.customer = $self;
}

@assert.unique: { licensePlate: [licensePlate] }
entity Vehicles : cuid, managed {
  licensePlate   : String(15)  not null;
  make           : String(40)  not null;
  model          : String(40)  not null;
  year           : Integer     not null;
  currentMileage : Integer     not null;

  customer      : Association to Customers not null;
  serviceOrders : Association to many ServiceOrders
                    on serviceOrders.vehicle = $self;
}

entity Mechanics : cuid, managed {
  name           : String(80)  not null;
  specialization : String(80)  not null;
  status         : MechanicStatus default #AVAILABLE not null;
  authUser       : String(50);

  serviceOrders : Association to many ServiceOrders
                    on serviceOrders.mechanic = $self;
}

@assert.unique: { orderNumber: [orderNumber] }
entity ServiceOrders : cuid, managed {
  orderNumber      : String(20)  not null;
  customer         : Association to Customers not null;
  vehicle          : Association to Vehicles  not null;
  mechanic         : Association to Mechanics;
  serviceDate      : Date        not null;
  mileageAtService : Integer     not null;
  status           : ServiceOrderStatus default #OPEN not null;

  laborCost     : Decimal(11, 2) default 0 not null;
  partsCost     : Decimal(11, 2) default 0 not null;
  totalCostGEL    : Decimal(11, 2) default 0 not null;
  totalCostEUR    : Decimal(11, 2);
  exchangeRate    : Decimal(12, 6);

  items : Composition of many ServiceItems
            on items.serviceOrder = $self;
}

entity ServiceItems : cuid, managed {
  serviceOrder : Association to ServiceOrders not null;
  description  : String(200) not null;
  itemType     : ServiceItemType not null;
  hours        : Decimal(5, 2);
  hourlyRate   : Decimal(9, 2);
  partPrice    : Decimal(9, 2);
  quantity     : Decimal(7, 2);
  lineTotal    : Decimal(11, 2) default 0 not null;
}
