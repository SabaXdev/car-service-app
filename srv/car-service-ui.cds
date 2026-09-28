using CarServiceService as service from './car-service';

annotate service.ServiceOrders with @(
  UI.HeaderInfo: {
    TypeName: '{i18n>ui.serviceOrder}',
    TypeNamePlural: '{i18n>ui.serviceOrders}',
    Title: {
      $Type: 'UI.DataField',
      Value: orderNumber
    },
    Description: {
      $Type: 'UI.DataField',
      Value: status
    }
  },
  UI.LineItem: [
    { Value: customer.name, Label: '{i18n>ui.customer}' },
    { Value: vehicle.make, Label: '{i18n>ui.make}' },
    { Value: vehicle.model, Label: '{i18n>ui.model}' },
    { Value: status, Label: '{i18n>ui.status}' },
    { Value: totalCostGEL, Label: '{i18n>ui.totalGel}' }
  ],
  UI.SelectionFields: [
    customer,
    vehicle,
    status,
    serviceDate,
    orderNumber
  ],
  UI.Identification: [
    {
      $Type: 'UI.DataFieldForAction',
      Action: 'CarServiceService.startService',
      Label: '{i18n>ui.startService}'
    },
    {
      $Type: 'UI.DataFieldForAction',
      Action: 'CarServiceService.completeService',
      Label: '{i18n>ui.completeService}'
    },
    {
      $Type: 'UI.DataFieldForAction',
      Action: 'CarServiceService.cancelService',
      Label: '{i18n>ui.cancelService}'
    },
    {
      $Type: 'UI.DataFieldForAction',
      Action: 'CarServiceService.refreshExchangeRate',
      Label: '{i18n>ui.refreshFxRate}'
    }
  ],
  UI.HeaderFacets: [
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'HeaderCustomer',
      Label: '{i18n>ui.headerCustomer}',
      Target: '@UI.FieldGroup#HeaderCustomer'
    },
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'HeaderMechanic',
      Label: '{i18n>ui.headerMechanic}',
      Target: '@UI.FieldGroup#HeaderMechanic'
    }
  ],
  UI.Facets: [
    {
      $Type: 'UI.CollectionFacet',
      ID: 'CustomerVehicleSection',
      Label: '{i18n>ui.customerVehicleSection}',
      Facets: [{
        $Type: 'UI.ReferenceFacet',
        ID: 'CustomerVehicleGroup',
        Label: '{i18n>ui.details}',
        Target: '@UI.FieldGroup#CustomerVehicle'
      }]
    },
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'ServiceItemsSection',
      Label: '{i18n>ui.serviceItems}',
      Target: 'items/@UI.LineItem'
    },
    {
      $Type: 'UI.CollectionFacet',
      ID: 'CostSummarySection',
      Label: '{i18n>ui.costSummary}',
      Facets: [{
        $Type: 'UI.ReferenceFacet',
        ID: 'CostSummaryGroup',
        Label: '{i18n>ui.totals}',
        Target: '@UI.FieldGroup#CostSummary'
      }]
    },
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'GeneralFacet',
      Label: '{i18n>ui.orderInformation}',
      Target: '@UI.FieldGroup#General'
    }
  ],
  UI.FieldGroup#HeaderCustomer: {
    Data: [
      { Value: customer.name, Label: '{i18n>ui.customer}' }
    ]
  },
  UI.FieldGroup#HeaderMechanic: {
    Data: [
      { Value: mechanic.name, Label: '{i18n>ui.headerMechanic}' },
      { Value: status, Label: '{i18n>ui.status}' }
    ]
  },
  UI.FieldGroup#CustomerVehicle: {
    Data: [
      { Value: customer.name, Label: '{i18n>ui.customer}' },
      { Value: customer.phone, Label: '{i18n>ui.phone}' },
      { Value: customer.email, Label: '{i18n>ui.email}' },
      { Value: customer.isFleetCustomer, Label: '{i18n>ui.isFleetCustomer}' },
      { Value: vehicle.make, Label: '{i18n>ui.make}' },
      { Value: vehicle.model, Label: '{i18n>ui.model}' },
      { Value: vehicle.year, Label: '{i18n>ui.year}' },
      { Value: vehicle.licensePlate, Label: '{i18n>ui.licensePlate}' },
      { Value: vehicle.currentMileage, Label: '{i18n>ui.currentMileageKm}' },
      { Value: mileageAtService, Label: '{i18n>ui.mileageAtServiceKm}' }
    ]
  },
  UI.FieldGroup#CostSummary: {
    Data: [
      { Value: laborCost, Label: '{i18n>ui.laborGel}' },
      { Value: partsCost, Label: '{i18n>ui.partsGel}' },
      { Value: totalCostGEL, Label: '{i18n>ui.totalGelSymbol}' },
      { Value: totalCostEUR, Label: '{i18n>ui.eurEquivalent}' },
      { Value: exchangeRate, Label: '{i18n>ui.exchangeRateGelEur}' }
    ]
  },
  UI.FieldGroup#General: {
    Data: [
      { Value: orderNumber },
      { Value: serviceDate },
      { Value: status },
      { Value: mechanic.name, Label: '{i18n>ui.assignedMechanic}' }
    ]
  }
);

annotate service.ServiceItems with @(
  UI.LineItem: [
    { Value: description, Label: '{i18n>ui.description}' },
    { Value: itemType, Label: '{i18n>ui.itemType}' },
    { Value: hours, Label: '{i18n>ui.hours}' },
    { Value: hourlyRate, Label: '{i18n>ui.hourlyRate}' },
    { Value: quantity, Label: '{i18n>ui.quantity}' },
    { Value: partPrice, Label: '{i18n>ui.partPrice}' },
    { Value: lineTotal, Label: '{i18n>ui.lineTotal}' }
  ]
);

annotate service.ServiceOrders with {
  customer @Common.ValueList: {
    Label: '{i18n>ui.valueListCustomers}',
    CollectionPath: 'Customers',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: customer_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'email' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'phone' }
    ]
  };
  vehicle @Common.ValueList: {
    Label: '{i18n>ui.valueListVehicles}',
    CollectionPath: 'Vehicles',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: vehicle_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'licensePlate' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'make' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'model' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'year' }
    ]
  };
  mechanic @Common.ValueList: {
    Label: '{i18n>ui.valueListMechanics}',
    CollectionPath: 'Mechanics',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: mechanic_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'specialization' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'status' }
    ]
  };
}

annotate service.Customers with {
  isFleetCustomer @Common.Label: '{i18n>ui.isFleetCustomer}';
};
