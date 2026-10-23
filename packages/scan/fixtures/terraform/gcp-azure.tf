resource "google_cloud_run_v2_service" "web" {
  name = "web"
}

resource "google_sql_database_instance" "db" {
  name = "main"
}

resource "azurerm_resource_group" "rg" {
  name     = "app"
  location = "westeurope"
}

resource "azurerm_linux_function_app" "fn" {
  name                = "fn"
  resource_group_name = azurerm_resource_group.rg.name
}

resource "azurerm_storage_account" "sa" {
  name                = "storage"
  resource_group_name = azurerm_resource_group.rg.name
}
